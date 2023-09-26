import sqlite3 from 'sqlite3';
import algosdk from 'algosdk';
import { algod } from '../include/algod.js';

const db = new sqlite3.Database('proposers.db');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function storeBlockInDb(block, proposer, timestamp) {
    return new Promise((resolve, reject) => {
        const stmt = db.prepare("INSERT OR REPLACE INTO blocks (block, proposer, timestamp) VALUES (?, ?, ?)");
        stmt.run(block, proposer, timestamp, err => {
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
    const highestStoredBlock = await getHighestStoredBlock();
    console.log(`Highest stored block in the database: ${highestStoredBlock}`);

    // get highest block from algod
    let end_block = (await algod.status().do())['last-round'];

    let last_block = highestStoredBlock;
    while(true) {
        if (last_block >= end_block) {
            process.stdout.clearLine();
            process.stdout.cursorTo(0);
            process.stdout.write(`Reached end of chain, sleeping for 10 seconds...`);
            await sleep(10000);
            end_block = (await algod.status().do())['last-round'];
            continue;
        }
		let i = last_block + 1;

        process.stdout.clearLine();
		process.stdout.cursorTo(0);
		process.stdout.write(`Retrieving block ${i} (${end_block - i} behind)`);
        
        try {
            const timeoutPromise = new Promise((resolve, reject) => {
                setTimeout(() => {
                    reject(new Error('Request timed out'));
                }, 5000); // 5 second timeout
            });

            const blk = await Promise.race([algod.block(i).do(), timeoutPromise]);
            const addr = algosdk.encodeAddress(blk["cert"]["prop"]["oprop"]);
            const timestamp = new Date(blk.block.ts*1000).toISOString();

            // store this block and its proposer in the database
            await storeBlockInDb(i, addr, timestamp);
        } catch (error) {
            process.stdout.clearLine();
            process.stdout.cursorTo(0);
            if (error.message === 'Request timed out') {
                process.stdout.write(`Error retrieving block ${i} from API: request timed out, retrying.`);
            } else {
                process.stdout.write(`Error retrieving block ${i} from API: ${error.message}, retrying.`);
            }
            await sleep(10000); // wait 10 seconds before trying again
            continue;
        }
	
        last_block = i;
	}

})();