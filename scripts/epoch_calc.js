/*

	Script to calculate epoch block rewards based on block proposers and epoch reward amount

	- Given start and end dates for epoch, find first and last block produced
	- Build array of block proposers during epoch, increment 1 per block produced
	- Given total epoch reward, calculate reward for each proposer based on percentage of blocks proposed during epoch
	- Write amounts to CSV (epoch_rewards.csv)

	Usage: node epoch_calc.js -s STARTTIME -e ENDTIME -r EPOCHREWARD -f FILENAME

*/

import algosdk from 'algosdk';
import minimist from 'minimist';
import { writeToCSV } from '../include/utils.js';

const c = new algosdk.Algodv2("", "https://testnet-api.algonode.cloud", "");

export const getFilenameArguments = () => {
    const args = minimist(process.argv.slice(2));
    let start_block = (args.s)??=null;
    let end_block = (args.e)??=null;
	let epoch_block_reward = (args.r)??=0;
	let output_filename = (args.f)??='epoch_rewards.csv';
    return [ start_block, end_block, epoch_block_reward, output_filename ];
}

(async () => {
	const [ start_block, end_block, epoch_block_reward, output_filename ] = getFilenameArguments();

	const epoch_total_blocks = end_block-start_block+1;
	console.log(`Total blocks produced in Epoch: ${epoch_total_blocks}`);
	console.log(`Finding block proposers between blocks ${start_block} and ${end_block}...`);

	let proposers = {};

	for(let i = start_block; i <= end_block; i++) {
		const blk = await c.block(i).do();
		const addr = algosdk.encodeAddress(blk["cert"]["prop"]["oprop"]);
		
		if (typeof proposers[addr] == 'undefined') {
			proposers[addr] = 1;
		}
		else {
			proposers[addr]++;
		}
	}

	// print out proposers list with tokens owed based on percentage proposed
	let rewards = [];
	for(let p in proposers) {
		const pct = Math.round((proposers[p] / epoch_total_blocks) * 10000) / 100;
		const reward = Math.round((proposers[p] / epoch_total_blocks) * epoch_block_reward);
		console.log(`${p}: ${proposers[p]} - ${pct}% - ${reward} VOI`);

		rewards.push({
			account: p,
			userType: 'node',
			tokenAmount: reward,
		});
	}

	// write out to CSV file
	writeToCSV(rewards,output_filename);
})();
