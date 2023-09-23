/*

	Script to calculate epoch block rewards based on block proposers and epoch reward amount

	- Given start and end dates for epoch, find first and last block produced
	- Build array of block proposers during epoch, increment 1 per block produced
	- Given total epoch reward, calculate reward for each proposer based on percentage of blocks proposed during epoch
	- Write amounts to CSV (epoch_rewards.csv)
	- START and END can be dates in format YYYY-MM-DD or block numbers

	Usage: node epoch_calc.js -s START -e END -r EPOCHREWARD -f FILENAME [-b <blacklist.csv>]

*/

import algosdk from 'algosdk';
import minimist from 'minimist';
import { algod } from '../include/algod.js';
import { sleep, fetchBlacklist, writeToCSV, getClosestBlock } from '../include/utils.js';
import sqlite3 from 'sqlite3';

const db = new sqlite3.Database('proposers.db');

// show help menu and exit
export const exitMenu = (err) => {
	if (err) console.log(`ERROR: ${err}`);
	console.log(`Command: node epoch_calc.js -s STARTTIME -e ENDTIME -r EPOCHREWARD -f FILENAME`);
	process.exit();
}

export const getFilenameArguments = () => {
    const args = minimist(process.argv.slice(2));
    let start_block = (args.s)??=null;
    let end_block = (args.e)??=null;
	let epoch_block_reward = (args.r)??=0;
	let output_filename = (args.f)??='epoch_rewards.csv';
    let blackList = (args.b)??=null;
    return [ start_block, end_block, epoch_block_reward, output_filename, blackList ];
}

function createBlocksTableIfNotExists() {
    return new Promise((resolve, reject) => {
        db.run(`
            CREATE TABLE IF NOT EXISTS blocks (
                block INTEGER PRIMARY KEY,
                proposer VARCHAR(58)
            )
        `, err => {
            if (err) return reject(err);
            resolve();
        });
    });
}

function getProposerFromDb(block) {
    return new Promise((resolve, reject) => {
        db.get("SELECT proposer FROM blocks WHERE block = ?", [block], (err, row) => {
            if (err) return reject(err);
            resolve(row ? row.proposer : null);
        });
    });
}

function storeBlockInDb(block, proposer) {
    return new Promise((resolve, reject) => {
        const stmt = db.prepare("INSERT OR REPLACE INTO blocks (block, proposer) VALUES (?, ?)");
        stmt.run(block, proposer, err => {
            if (err) return reject(err);
            resolve();
        });
        stmt.finalize();
    });
}

async function getHighestStoredBlock() {
    return new Promise((resolve, reject) => {
        db.get("SELECT MAX(block) as highestBlock FROM blocks", [], (err, row) => {
            if (err) return reject(err);
            resolve(row ? row.highestBlock : 0);
        });
    });
}

(async () => {
	const [ start_time, end_time, epoch_block_reward, output_filename, blacklistFileName ] = getFilenameArguments();

	// Ensure the blocks table exists
	await createBlocksTableIfNotExists();

	if (start_time == null || end_time == null) {
		exitMenu(`Start and end blocks required`);
	}

	const highestStoredBlock = await getHighestStoredBlock();
    console.log(`Highest stored block in the database: ${highestStoredBlock}`);

	let start_block = start_time;
	let end_block = end_time;

	// find start and end blocks for epoch
	console.log(`Looking for starting and ending blocks for range: ${start_time} to ${end_time}...`);

	if (start_time.length == 10 && start_time.indexOf('-') !== -1) {
		const startTime = new Date(start_time+'T00:00:00Z');
		start_block = await getClosestBlock(startTime);
	}
	const startBlockDetail = await algod.block(start_block).do();
	const startBlockTime = new Date(startBlockDetail.block.ts * 1000);

	let endBlockDetail = null;
	let endBlockTime = null;
	if (end_time.length == 10 && end_time.indexOf('-') !== -1) {
		const endTime = new Date(end_time+'T23:59:59Z');
		end_block = await getClosestBlock(endTime);

		endBlockDetail = await algod.block(end_block).do();
		endBlockTime = new Date(endBlockDetail.block.ts * 1000);
		if (endBlockTime > endTime) {
			end_block--;
			endBlockDetail = await algod.block(end_block).do();
			endBlockTime = new Date(endBlockDetail.block.ts * 1000);
		}
	}
	else {
		endBlockDetail = await algod.block(end_block).do();
		endBlockTime = new Date(endBlockDetail.block.ts * 1000);
	}

	console.log(`Start Block: ${start_block} @ ${startBlockTime.toUTCString()}`);
	console.log(`End Block:   ${end_block} @ ${endBlockTime.toUTCString()}`);

	// calc total blocks in epoch
	const epoch_total_blocks = end_block-start_block+1;
	console.log(`Total blocks produced in Epoch: ${epoch_total_blocks}`);
	console.log(`Finding block proposers between blocks ${start_block} and ${end_block}...`);

    // handle blacklist
    let blacklist = []; // list of addresses to not send to
    if (blacklistFileName != null && blacklistFileName != false) {
        if (fs.existsSync(blacklistFileName) && validateFile(blacklistFileName)) {
            blacklist = await csvToJson(blacklistFileName);
        }
    }

    // pull in additional blacklist addresses from API
    try {
        const blacklistFromApi = await fetchBlacklist();
        blacklist = blacklist.concat(blacklistFromApi);
    } catch (error) {
        exitMenu(`Unable to fetch blacklist from API: `, error);
    }
	blacklist = blacklist.map(item => item.account);

	let proposers = {};
	let proposedBlockCount = 0;

	for(let i = start_block; i <= end_block; i++) {
		if (i%10 == 0) {
			process.stdout.clearLine();
			process.stdout.cursorTo(0);
			process.stdout.write(`Retrieving block ${i} (${end_block - i} remaining)`);
		}

        let addr = await getProposerFromDb(i);

		if (!addr) {
			try {
				const blk = await algod.block(i).do();
				addr = algosdk.encodeAddress(blk["cert"]["prop"]["oprop"]);
	
				// store this block and its proposer in the database
				await storeBlockInDb(i, addr);
			} catch (error) {
				process.stdout.clearLine();
				process.stdout.cursorTo(0);
				process.stdout.write(`Error retrieving block ${i} from API, retrying.`);
				await sleep(10000); // wait 10 seconds before trying again
				i--;  // Decrement the block counter to retry the same block after sleeping.
				continue;
			}
		}
	
        // skip if address is in blacklist
        if (blacklist.includes(addr)) continue;

        if (typeof proposers[addr] == 'undefined') {
            proposers[addr] = 1;
        } else {
            proposers[addr]++;
        }
		proposedBlockCount++;
	}

	// print out proposers list with tokens owed based on percentage proposed
	let rewards = [];
	for(let p in proposers) {
		const pct = Math.round((proposers[p] / proposedBlockCount) * 10000) / 100;
		const reward = Math.round((proposers[p] / proposedBlockCount) * epoch_block_reward * Math.pow(10,6));
		console.log(`${p}: ${proposers[p]} - ${pct}% - ${reward / Math.pow(10,6)} VOI`);

		rewards.push({
			account: p,
			userType: proposers[p],
			percent: pct,
			tokenAmount: (reward / Math.pow(10,6))+' VOI',
		});

		/*rewards.push({
			account: p,
			userType: 'node',
			tokenAmount: reward,
		});*/
	}
	console.log(`Total blocks produced by non-blacklisted addresses: ${proposedBlockCount}`);

	// write out to CSV file
	writeToCSV(rewards,output_filename);
})();
