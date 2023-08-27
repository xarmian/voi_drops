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
import { writeToCSV } from './utils.js';

const default_epoch_start = '2023-08-25T00:00:00';
const default_epoch_end = '2023-08-25T00:01:00';
//const epoch_block_reward = 1000000;

//const previous_block = 13819292; // TODO: read from DB, or on-chain tx

const c = new algosdk.Algodv2("", "https://testnet-api.algonode.cloud", "");

export const getFilenameArguments = () => {
    const args = minimist(process.argv.slice(2));
    let epoch_start = (args.s)??=default_epoch_start; // TODO MAKE NULL
    let epoch_end = (args.e)??=default_epoch_end; // TODO MAKE NULL
	let epoch_block_reward = (args.r)??=0;
	let output_filename = (args.f)??='epoch_rewards.csv';
    return [ epoch_start, epoch_end, epoch_block_reward, output_filename ];
}

async function getClosestBlock(timestamp,lowerBound = 1) {
    let upperBound = (await c.status().do())['last-round'];
    //let lowerBound = 1; // Start from block 1, adjust if you have a better starting point

    while (lowerBound <= upperBound) {
        const midPoint = Math.floor((upperBound + lowerBound) / 2);
        const block = await c.block(midPoint).do();
        const blockTime = block.block.ts * 1000; // Convert from seconds to milliseconds

        if (blockTime < timestamp) {
            lowerBound = midPoint + 1;
        } else if (blockTime > timestamp) {
            upperBound = midPoint - 1;
        } else {
            return midPoint;  // Exact match, though this is unlikely
        }
    }

    return lowerBound; // Returns block with timestamp just after the given timestamp
}

(async () => {
	const [ epoch_start, epoch_end, epoch_block_reward, output_filename ] = getFilenameArguments();

    const startDate = new Date(epoch_start).getTime();
    const endDate = new Date(epoch_end).getTime() - 1000; // one second less to avoid conflict with next epoch

	process.stdout.write(`Calculating Epoch starting block... `);
    const start_block = await getClosestBlock(startDate);
	console.log(start_block);

	process.stdout.write(`Calculating Epoch ending block... `);
	const end_block = await getClosestBlock(endDate,start_block)-1; // subtract one to get 
	console.log(end_block);

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
