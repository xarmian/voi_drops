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
import { fetchBlacklist, writeToCSV, validateFile, csvToJson } from '../include/utils.js';

// show help menu and exit
export const exitMenu = (err) => {
	if (err) console.log(`ERROR: ${err}`);
	console.log(`Command: node epoch_calc.js -s STARTDATE -e ENDDATE -r EPOCHREWARD [-f FILENAME] [-b BLACKLIST]`);
	process.exit();
}

export const getFilenameArguments = () => {
    const args = minimist(process.argv.slice(2));
    let start_date = (args.s)??=null;
    let end_date = (args.e)??=null;
	let epoch_block_reward = (args.r)??=0;
	let output_filename = (args.f)??='epoch_rewards.csv';
    let blackList = (args.b)??=null;
    return [ start_date, end_date, epoch_block_reward, output_filename, blackList ];
}

(async () => {
	const [ start_date, end_date, epoch_block_reward, output_filename, blacklistFileName ] = getFilenameArguments();

	if (start_date == null || end_date == null) {
		exitMenu(`Start and end blocks required`);
	}

    // handle blacklist
    let blacklist = []; // list of addresses to not send to
    if (blacklistFileName != null && blacklistFileName != false) {
        if (fs.existsSync(blacklistFileName) && validateFile(blacklistFileName)) {
            blacklist = await csvToJson(blacklistFileName);
        }
    }

    // pull in additional blacklist addresses from API
    /*try {
        const blacklistFromApi = await fetchBlacklist();
        blacklist = blacklist.concat(blacklistFromApi);
    } catch (error) {
        exitMenu(`Unable to fetch blacklist from API: `, error);
    }*/
	blacklist = blacklist.map(item => item.account);

	let proposers = {};
	let proposedBlockCount = 0;

    const url = `https://socksfirstgames.com/proposers/?start=${start_date}&end=${end_date}`;

    await fetch(url,{cache: "no-store"})
        .then(response => response.json())
        .then(data => {
            const dataArrays = data.data;

            // Sort the data by block count
            dataArrays.sort((a, b) => b.block_count - a.block_count);

            let totalBlocks = 0;
            let totalWallets = 0;

			dataArrays.forEach(row => {
				if (blacklist.includes(row.proposer)) return;
				proposers[row.proposer] = row.block_count;
				proposedBlockCount += row.block_count;
                totalWallets++;
            });
        });
	
	console.log('');

	// print out proposers list with tokens owed based on percentage proposed
	let rewards = [];
	for(let p in proposers) {
		const pct = proposers[p] / proposedBlockCount;
		const reward = Math.round((proposers[p] / proposedBlockCount) * epoch_block_reward * Math.pow(10,6));
		console.log(`${p}: ${proposers[p]} - ${pct} - ${reward / Math.pow(10,6)} VOI`);

		/*rewards.push({
			account: p,
			userType: proposers[p],
			percent: pct,
			tokenAmount: (reward / Math.pow(10,6))+' VOI',
		});*/

		rewards.push({
			account: p,
			userType: 'node',
			tokenAmount: reward,
		});
	}
	console.log(`Total blocks produced by non-blacklisted addresses: ${proposedBlockCount}`);

	// write out to CSV file
	writeToCSV(rewards,output_filename);
})();
