import algosdk from 'algosdk';
import fs from 'fs';
import csv from 'fast-csv';
import csvWriter from 'csv-writer';

export const sleep = async (ms) => {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// show help menu and exit
export const exitMenu = (err) => {
	if (err) console.log(`ERROR: ${err}`);
	console.log(`Command: node airdrop.js -a <acctlist> [-b <blacklist>] [-g <group_size>] [-m "mnemonic of sender"]`);
	process.exit();
}

// TODO: validate csv
export const validateFile = async (file) => {
	return true;
}

// iterate over dropList. add addresses to array. if duplicate or invalid address found remove from array and add address to errorList
// return errorList
export const removeAndTrackDuplicates = (array, blacklist) => {
    let errorList = [];
    let accountMap = new Map();

    // Count the number of occurrences of each account
    for (let obj of array) {
        if (accountMap.has(obj.account)) {
            accountMap.set(obj.account, accountMap.get(obj.account) + 1);
        } else {
            accountMap.set(obj.account, 1);
        }
    }

    // Add duplicates to errorList and filter them out from the original array
    errorList = array.filter(obj => accountMap.get(obj.account) > 1).map(obj => ({...obj, error: 'duplicate account'}));
    array = array.filter(obj => accountMap.get(obj.account) === 1);

    return [ array, errorList ];
}

export const removeInvalidAddresses = (array, errorList) => {
    for (let objid in array) {
        if (!algosdk.isValidAddress(array[objid].account)) {
            errorList.push({...array[objid], error: 'invalid address'});
            array.splice(objid,1);
        }
    }

    return [ array, errorList ];
}

// remove blacklisted addresses from airdrop array
export const sanitizeWithRemovals = (array, blacklist) => {
    let blacklistObj = {};
    for (let obj of blacklist) {
        blacklistObj[obj.account] = 1;
    }
    array = array.filter(obj => blacklistObj[obj.account] !== 1);
    return array;
}

export const csvToJson = async (filename) => {
    const results = [];
    return new Promise((resolve, reject) => {
        fs.createReadStream(filename)
            .pipe(csv.parse({ headers: true, ignoreEmpty: true }))
            .validate(data => {
                return Object.values(data).every(val => val !== undefined);
            })
            .transform(row => Object.entries(row).reduce((obj, [key, value]) => ({ ...obj, [key.trim()]: value.trim() }), {}))
            .on('data', row => results.push(row))
            .on('end', () => resolve(results))
            .on('error', error => reject(error));
    });
}

// tries to write objects contained in `array` to `filename`
// returns true on success, false on failure
export const writeToCSV = async (array, filename) => {
    try {
        if (array.length > 0) {
            let headers = Object.keys(array[0]);
            headers.forEach((h,i) => headers[i] = { id: h, title: h });

            const writer = csvWriter.createObjectCsvWriter({
                path: filename,
                header: headers,
                append: false,
            });
            await writer.writeRecords(array);
        }
        return true;
    }
    catch(err) {
        return false;
    }
}