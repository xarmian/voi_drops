// Tests for epoch_calc_api.js
//
// Usage: node epoch_calc_api_test.js -f <CSV FILE PRODUCED BY epoch_calc_api.js>
//

import minimist from 'minimist';
import { writeToCSV, validateFile, csvToJson } from '../include/utils.js';

// accept a filename of reward distribution CSV as cli argument and open it
const getFilenameArguments = () => {
    const args = minimist(process.argv.slice(2));
    let filename = (args.f)??=null;
    return filename;
}

(async () => {
    const filename = getFilenameArguments();

    // if filename is null, show error
    if (filename == null) {
        console.log(`ERROR: Filename required`);
        process.exit();        
    }

    // open CSV file and iterate over each line, ignoring header line
    const file = await csvToJson(filename);
    let total_rewards = 0;
    let total_block_rewards = 0;
    let total_health_rewards = 0;
    
    // iterate over each line of the CSV file
    file.forEach((line, index) => {
        //if (index == 0) return; // skip header line
        total_rewards += parseFloat(line.tokenAmount);
        let rewards = JSON.parse(line.note);
        total_block_rewards += parseFloat(rewards.blockRewards);
        total_health_rewards += parseFloat(rewards.healthRewards);
    });

    // compare total rewards to expected rewards
    console.log(`Total block rewards: ${total_block_rewards}`);
    console.log(`Total health rewards: ${total_health_rewards}`);
    console.log(`Total rewards: ${total_rewards/Math.pow(10,6)}`);

})();

