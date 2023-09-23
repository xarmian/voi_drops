/*

	Script to find the next block following a specified date/time using a binary search.
	Time must be formatted as YYYY-MM-DDTHH:MM:SSZ, i.e. 2023-08-28T13:04:33Z

    This script will also accept a date without a time in the format YYYY-MM-DD
    and will output the start and end blocks for that date (midnight to midnight GMT)
    along with the command to run epoch_calc.js

    Leave off -t parameter to use current date

	Usage: node find_block.js [-t TIMESTAMP]

*/
import minimist from 'minimist';
import { algod } from '../include/algod.js';
import { getClosestBlock } from '../include/utils.js';

export const getFilenameArguments = () => {
    const args = minimist(process.argv.slice(2));
    let timestamp = args.t ? args.t : new Date().toISOString().substring(0, 10);
    return [timestamp];
}

(async () => {
	const [ timestamp ] = getFilenameArguments();

	if (timestamp == 0) {
		console.log('Timestamp of format YYYY-MM-DD[THH:MM:SS[Z]] required using -t');
		console.log('If only a date component is supplied, this script will locate the first and last block in GMT time on that particular date');
		console.log('Example using GMT Time:       node find_block.js -t 2023-08-28T13:04:33Z');
		console.log('Example using Local Timezone: node find_block.js -t 2023-08-28T13:04:33');
        console.log('Example using Date only:      node find_block.js -t 2023-08-28');
        process.exit();
	}

    if (timestamp.length == 10) {
        console.log(`Looking for starting and ending blocks for ${timestamp}...`);
        const startTime = new Date(timestamp+'T00:00:00Z');
        const startBlock = await getClosestBlock(startTime);
        const startBlockDetail = await algod.block(startBlock).do();
        const startBlockTime = new Date(startBlockDetail.block.ts * 1000);

        const endTime = new Date(timestamp+'T23:59:59Z');
        let endBlock = await getClosestBlock(endTime);
        let endBlockDetail = await algod.block(endBlock).do();
        let endBlockTime = new Date(endBlockDetail.block.ts * 1000);
        if (endBlockTime > endTime) {
            endBlock--;
            endBlockDetail = await algod.block(endBlock).do();
            endBlockTime = new Date(endBlockDetail.block.ts * 1000);
        }

        console.log(`Start Block: ${startBlock} @ ${startBlockTime.toUTCString()}`);
        console.log(`End Block:   ${endBlock} @ ${endBlockTime.toUTCString()}`);
        console.log(``);
        console.log(`Epoch Rewards Calc Command: node epoch_calc.js -s ${startBlock} -e ${endBlock} -r <rewards> [-f <csvfile>]`);
    }
    else {
        const useTime = new Date(timestamp).valueOf();

        process.stdout.write(`Calculating block at ${timestamp} ... `);
        const block = await getClosestBlock(useTime);
        console.log(block);

        // get actual block time
        const detail = await algod.block(block).do();
        const tm = new Date(detail.block.ts * 1000); 
        console.log(`Actual block time: ${tm.toString()}`);
        console.log(`                   ${tm.toUTCString()}`);
    }

	process.exit();
})();
