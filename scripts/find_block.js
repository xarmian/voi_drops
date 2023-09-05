/*

	Script to find the next block following a specified date/time using a binary search.
	Time must be formatted as YYYY-MM-DDTHH:MM:SS, i.e. 2023-08-28T13:04:33

	Usage: node find_block.js -t TIMESTAMP

*/

import algosdk from 'algosdk';
import minimist from 'minimist';

const c = new algosdk.Algodv2("", "https://testnet-api.voi.nodly.io", "");

export const getFilenameArguments = () => {
    const args = minimist(process.argv.slice(2));
    let timestamp = (args.t)??=0;
    return [ timestamp ];
}

async function getClosestBlock(timestamp,lowerBound = 1) {
    let upperBound = (await c.status().do())['last-round'];

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
	const [ timestamp ] = getFilenameArguments();

	if (timestamp == 0) {
		console.log('GMT Timestamp of format YYYY-MM-DDTHH:MM:SS required using -t');
		console.log('Usage: node find_block.js -t 2023-08-28T13:04:33');
		process.exit();
	}

    const useTime = new Date(timestamp).getTime();

	process.stdout.write(`Calculating block at ${timestamp} ... `);
    const block = await getClosestBlock(useTime);
	console.log(block);

	// get actual block time
	const detail = await c.block(block).do();
	const tm = new Date(detail.block.ts * 1000).toLocaleString();
	console.log(`Actual block time: ${tm}`);

	process.exit();
})();