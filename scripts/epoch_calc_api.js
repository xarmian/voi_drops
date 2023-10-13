/*

	Script to calculate epoch block rewards based on block proposers and epoch reward amount

	- Given start and end dates for epoch, find first and last block produced
	- Build array of block proposers during epoch, increment 1 per block produced
	- Given total epoch reward, calculate reward for each proposer based on percentage of blocks proposed during epoch
	- Write amounts to CSV (epoch_rewards.csv)
	- Utilizes public API endpoint to retrieve list of proposers rather than local SQLite database
	- START and END must be dates in format YYYY-MM-DD

	Usage: node epoch_calc.js -s START -e END -r EPOCHREWARD -f FILENAME [-b <blacklist.csv>]

*/

import fs from 'fs';
import minimist from 'minimist';
import { writeToCSV, validateFile, csvToJson } from '../include/utils.js';

// show help menu and exit
const exitMenu = (err) => {
	if (err) console.log(`ERROR: ${err}`);
	console.log(`Usage: node epoch_calc.js -s STARTDATE -e ENDDATE -r EPOCHREWARD -h HEALTHREWARD [-f FILENAME] [-b BLACKLIST]`);
	process.exit();
}

const getFilenameArguments = () => {
    const args = minimist(process.argv.slice(2));
    let start_date = (args.s)??=null;
    let end_date = (args.e)??=null;
	let epoch_block_reward = (args.r)??=0;
	let epoch_health_reward = (args.h)??=0;
	let output_filename = (args.f)??='epoch_rewards.csv';
    let blackList = (args.b)??=null;
    return [ start_date, end_date, epoch_block_reward, epoch_health_reward, output_filename, blackList ];
}

(async () => {
	const [ start_date, end_date, epoch_block_reward, epoch_health_reward, output_filename, blacklistFileName ] = getFilenameArguments();

	if (start_date == null || end_date == null) {
		exitMenu(`Start and end blocks required`);
	}

    // handle blacklist
    // api automatically accounts for its own blackli
    let blacklist = []; // list of addresses to not send to
    if (blacklistFileName != null && blacklistFileName != false) {
        if (fs.existsSync(blacklistFileName) && validateFile(blacklistFileName)) {
            blacklist = await csvToJson(blacklistFileName);
        }
    }

	// map blacklist to array of addresses
	blacklist = blacklist.map(item => item.account);

	let proposers = {};
	let proposedBlockCount = 0;
	let healthy_node_count = 0;

    const url = `https://socksfirstgames.com/proposers/?start=${start_date}&end=${end_date}`;

    await fetch(url,{cache: "no-store"})
        .then(response => response.json())
        .then(data => {
            const dataArrays = data.data;
			healthy_node_count = data.healthy_node_count - data.empty_node_count;

            // Sort the data by block count
            dataArrays.sort((a, b) => b.block_count - a.block_count);

            let totalWallets = 0;

			dataArrays.forEach(row => {
				if (blacklist.includes(row.proposer)) return;
				proposers[row.proposer] = { 
					blocks: row.block_count,
					health_score: row.node.health_score,
					health_divisor: row.node.health_divisor,
				};
				proposedBlockCount += row.block_count;
				//if (Number(row.node.health_score) >= 5.0) healthy_node_count++;
                totalWallets++;
            });
        });
	
	console.log('');
	
	// order proposers by block count
	proposers = Object.fromEntries(Object.entries(proposers).sort(([,a],[,b]) => b.blocks - a.blocks));

	// print out proposers list with tokens owed based on percentage proposed
	let rewards = [];
	for(let p in proposers) {
		// calc block rewards
		const pct = proposers[p].blocks / proposedBlockCount;
		const block_reward = Math.round((proposers[p].blocks / proposedBlockCount) * epoch_block_reward * Math.pow(10,6));
		
		// calc health rewards
		const health_reward = (parseFloat(proposers[p].health_score) >= 5) ? Math.round((epoch_health_reward / healthy_node_count / proposers[p].health_divisor) * Math.pow(10,6)) : 0;

		console.log(`${p}: ${proposers[p].blocks} - ${pct} - ${block_reward / Math.pow(10,6)} VOI - ${health_reward / Math.pow(10,6)} VOI`);

		rewards.push({
			account: p,
			userType: 'node',
			tokenAmount: block_reward + health_reward,
			note: JSON.stringify({
				blockRewards: block_reward / Math.pow(10,6),
				healthRewards: health_reward / Math.pow(10,6),
			}),
		});
	}
	console.log(`Total blocks produced by non-blacklisted addresses: ${proposedBlockCount}`);

	// write out to CSV file
	writeToCSV(rewards,output_filename);
})();
