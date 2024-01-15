/*

	Script to calculate epoch block rewards based on block proposers and epoch reward amount

	- Given start and end dates for epoch, find first and last block produced
	- Build array of block proposers during epoch, increment 1 per block produced
	- Given total epoch reward, calculate reward for each proposer based on percentage of blocks proposed during epoch
	- Write amounts to CSV (epoch_rewards.csv)
	- Utilizes public API endpoint to retrieve list of proposers rather than local SQLite database
	- START and END must be dates in format YYYY-MM-DD

	Usage: node epoch_calc.js -s START -e END -r EPOCHREWARD -f FILENAME [-b <blacklist.csv>]

	Unit Test Ideas
	- Iterate over the CSV file, sum of column two should equal EPOCHREWARD + HEALTHREWARD
	- Iterate over the CSV file, json_decode column three, sum of blockRewards should equal EPOCHREWARD
	- Iterate over the CSV file, json_decode column three, sum of healthRewards should equal HEALTHREWARD
	- Iterate over the CSV file, json_decode column three, sum of blockRewards + healthRewards should equal EPOCHREWARD + HEALTHREWARD
	- Iterate over the CSV file, json_decode column three, sum of blockRewards + healthRewards should equal sum of column two
*/

import fs from 'fs';
import minimist from 'minimist';
import { writeToCSV, validateFile, csvToJson } from '../include/utils.js';
import { compareVersions } from 'compare-versions';

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
    // api automatically accounts for its own blacklist
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

    let url = `https://api.voirewards.com/proposers/index_v3.php?start=${start_date}&end=${end_date}`;
	
	// add blacklist to url
	if (blacklist.length > 0) url += `&blacklist=${blacklist.join(',')}`;

	// if process.env.APIKEY, send as header key/value pair X-Api-Key in fetch()
	let headers = {};
	if (typeof process.env.MNEMONIC != 'undefined') headers = { 'X-Api-Key': process.env.APIKEY };

	let MIN_ALGOD_VERSION = '1.0.0';

    await fetch(url,{headers: headers, cache: "no-store"})
        .then(response => response.json())
        .then(data => {
            const dataArrays = data.data;
			healthy_node_count = data.healthy_node_count - data.empty_node_count - data.extra_node_count;

            // Sort the data by block count
            dataArrays.sort((a, b) => b.block_count - a.block_count);

            let totalWallets = 0;

			dataArrays.forEach(row => {
				if (blacklist.includes(row.proposer)) {
					// if proposer is in blacklist and health_divisor == 1, subtract from healthy_node_count
					row.nodes.forEach(node => {
						if (node.health_divisor == 1 && node.health_score >= 5.0) healthy_node_count--;
					});

					return;
				}
				proposers[row.proposer] = { 
					blocks: row.block_count,
					nodes: row.nodes,
				};
				proposedBlockCount += row.block_count;
				//if (Number(row.node.health_score) >= 5.0) healthy_node_count++;
                totalWallets++;

				if (row.nodes) {
					for (let j = 0; j < row.nodes.length; j++) {
					  const node = row.nodes[j];
					  if (compareVersions(node.ver,MIN_ALGOD_VERSION)) {
						MIN_ALGOD_VERSION = node.ver;
					  }
					}
				  }
			  });

			if (compareVersions(MIN_ALGOD_VERSION,'3.21.0')) MIN_ALGOD_VERSION = '3.18.0';
		});
	
	// order proposers by block count
	proposers = Object.fromEntries(Object.entries(proposers).sort(([,a],[,b]) => b.blocks - a.blocks));

	// print out proposers list with tokens owed based on percentage proposed
	let rewards = [];
	for(let p in proposers) {
		const item = proposers[p];
				
		// calc block rewards
		const pct = proposers[p].blocks / proposedBlockCount;
		const block_reward = Math.floor(Math.ceil((proposers[p].blocks / proposedBlockCount) * epoch_block_reward * Math.pow(10,7))/10);
		
		// sort elements in item.nodes from lowest health_divisor to highest
		item.nodes.sort((a, b) => a.health_divisor - b.health_divisor);

		// try to get the first index of an element in item.nodes with a health_score >= 5.0
		let health_reward = 0;
		const healthyNodeIndex = item.nodes.findIndex((node) => node.health_score >= 5.0 && compareVersions(node.ver,MIN_ALGOD_VERSION) >= 0);
		//const healthyNodeIndex = item.nodes.findIndex(node => node.health_score >= 5.0);
		if (healthyNodeIndex !== -1) {
			health_reward = Math.floor(Math.ceil(epoch_health_reward / healthy_node_count / item.nodes[healthyNodeIndex].health_divisor * Math.pow(10,7)) / 10);
		}

		// calc health rewards
		// for each node, if health_score >= 5, add to healthy_node_count
		/*let health_reward = 0;
		proposers[p].nodes.forEach(node => {
			if (node.health_score >= 5.0) {
				health_reward += Math.floor(Math.ceil((epoch_health_reward / healthy_node_count / node.health_divisor) * Math.pow(10,7))/10);
			}
		});*/

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
	console.log(`Total healthy nodes: ${healthy_node_count}`);

	// ouput Block Rewards Expected vs. Actual, formatted
	console.log('');
	console.log(`Block Rewards  -- Expected: ${epoch_block_reward.toFixed(6).padStart(18)} VOI     Actual: ${rewards.reduce((a,b) => a + JSON.parse(b.note).blockRewards,0).toFixed(6).padStart(18)} VOI`);
	console.log(`Health Rewards -- Expected: ${epoch_health_reward.toFixed(6).padStart(18)} VOI     Actual: ${rewards.reduce((a,b) => a + JSON.parse(b.note).healthRewards,0).toFixed(6).padStart(18)} VOI`);
	console.log(`Total Rewards  -- Expected: ${(epoch_block_reward + epoch_health_reward).toFixed(6).padStart(18)} VOI     Actual: ${(rewards.reduce((a,b) => a + b.tokenAmount,0) / Math.pow(10,6)).toFixed(6).padStart(18)} VOI`);
	console.log('');


	// write out to CSV file
	writeToCSV(rewards,output_filename);
})();
