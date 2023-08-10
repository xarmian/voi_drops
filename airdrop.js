/*
	Script to perform airdrops to accounts utilizing CSV file as data source
    mnemonic can be passed with an optional -m parameter, or set as the environment variable MNEMONIC

    WORK IN PROGRESS DO NOT USE AS-IS

	Usage: node airdrop.js -a <acctlist> [-b <blacklist>] [-g <group_size>] [-m "mnemonic"]
*/

import algosdk from 'algosdk';
import fs from 'fs';
import minimist from 'minimist';
import csv from 'fast-csv';
import csvWriter from 'csv-writer';

const algodClient = new algosdk.Algodv2("", "https://testnet-api.algonode.cloud", "");

//const ws = fs.createWriteStream('successList.csv');
//csv.writeToStream(ws, successDropList, { headers: false });

//csv.writeToStream(ws, [ { x:1, y:2, z:3 } ], { headers: false, flags: 'a' });
//process.exit();

/* ***********************************
   ********* Extractable *************
   ***********************************
*/  
const sleep = async (ms) => {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// show help menu and exit
const exitMenu = (err) => {
	if (err) console.log(`ERROR: ${err}`);
	console.log(`Command: node airdrop.js -a <acctlist> [-b <blacklist>] [-g <group_size>] [-m "mnemonic of sender"]`);
	process.exit();
}

// TODO: validate csv
const validateFile = async (file) => {
	return true;
}

// iterate over dropList. add addresses to array. if duplicate or invalid address found remove from array and add address to errorList
// return errorList
const removeAndTrackDuplicates = (array, blacklist) => {
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

const removeInvalidAddresses = (array, errorList) => {
    for (let objid in array) {
        if (!algosdk.isValidAddress(array[objid].account)) {
            errorList.push({...array[objid], error: 'invalid address'});
            array.splice(objid,1);
        }
    }

    return [ array, errorList ];
}

// remove blacklisted addresses from airdrop array. "array" is 
const sanitizeWithRemovals = (array, blacklist) => {
    let blacklistObj = {};
    for (let obj of blacklist) {
        blacklistObj[obj.account] = 1;
    }
    array = array.filter(obj => blacklistObj[obj.account] !== 1);
    return array;
}

function getFilenameArguments() {
    const args = minimist(process.argv.slice(2));
    let acctList = (args.a)??=null;
    let blackList = (args.b)??=null;
    let mnemonic = (args.m)??=null;
    let testMode = (args.t)??=false;
    let groupSize = (args.g)??=1;
    return [ acctList, blackList, mnemonic, testMode, groupSize ];
}

async function csvToJson(filename) {
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
async function writeToCSV(array, filename) {
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

async function transferTokens(sender,array, successStream, errorStream, groupSize) {
    let successList = [];
    let errorList = [];
    const params = await algodClient.getTransactionParams().do();
    let txGroup = [];
    let objInGroup = [];

    for (let i = 0; i < array.length; i++) {
        let obj = array[i];
        const txn = algosdk.makePaymentTxnWithSuggestedParams(sender.addr, obj.account, parseInt(obj.tokenAmount), undefined, algosdk.encodeObj({'userType': obj.userType}),params);

        txGroup.push(txn);
        objInGroup.push(obj);

        // if group isn't full and its not the last transaction, continue filling group
        if (groupSize < 1) groupSize = 1;
        if (txGroup.length < groupSize && i < (array.length-1)) continue;
        
        // assign group ID
        algosdk.assignGroupID(txGroup);

        // sign transactions
        const signedTxns = [];
        for (let tid in txGroup) {
            let t = txGroup[tid];
            objInGroup[tid].txId = t.txID().toString();
            signedTxns.push(t.signTxn(sender.sk));
        }

        try {
            const { txId } = await algodClient.sendRawTransaction(signedTxns).do();
            let confirmedTxn = await waitForConfirmation(algodClient, txId, 8);
            if (confirmedTxn) {
                for (let o of objInGroup) {
                    //o['confirmed-round'] = confirmedTxn['confirmed-round'];
                    successList.push(o);
                    console.log(`Sent ${o.tokenAmount} to ${o.account}`);
                }

                //await writeToCSV(successList,'successList.csv');
                await successStream.writeRecords(objInGroup);
            }
        } catch (error) {
            for (let o of objInGroup) {
                o.error = (error && error.response && error.response.body && error.response.body.message) ? error.response.body.message : error.toString().substring(0,40);
                errorList.push(o);
                console.log(`Error sending ${o.tokenAmount} to ${o.account}`);
            }

            await errorStream.writeRecords(objInGroup);
        }

        txGroup = [];
        objInGroup = [];
    }
    return [ successList, errorList ];
}

async function waitForConfirmation(algodClient, txId, timeout) {
    let startTime = new Date().getTime();
    let txInfo = await algodClient.pendingTransactionInformation(txId).do();
    while (txInfo['confirmed-round'] === null && new Date().getTime() - startTime < timeout * 1000) {
        sleep(1000);
        txInfo = await algodClient.pendingTransactionInformation(txId).do();
    }
    if (txInfo['confirmed-round'] !== null) {
        return txInfo;
    }
    return null;
}

/* ******* End Extractable ********/
/* ******* START SCRIPT ***********/

(async () => {
    let [ acctFileName, blacklistFileName, paramMnemonic, testMode, groupSize ] = getFilenameArguments();

    // handle accotFileName
    if (acctFileName == null || acctFileName == false) exitMenu('Invalid command line arguments');
    if (!fs.existsSync(acctFileName)) {
        exitMenu('Account file missing or invalid');
    }
    
    if (!validateFile(acctFileName)) {
        exitMenu('Accounts file invalid');
    }
    
    // handle blacklist
    let blacklist = []; // list of addresses to not send to
    if (blacklistFileName != null && blacklistFileName != false) {
        if (fs.existsSync(blacklistFileName) && validateFile(blacklistFileName)) {
            blacklist = await csvToJson(blacklistFileName);
        }
    }

    let alreadySent = [];
    let resume = false;
    const successFileName = 'successFile.csv';
    if (fs.existsSync(successFileName) && validateFile(successFileName)) {
        resume = true;
        alreadySent = await csvToJson(successFileName);
    }

    const removeList = blacklist.concat(alreadySent);

    // handle senderMnemonic
    if (typeof process.env.MNEMONIC == 'undefined' && paramMnemonic == null) {
        exitMenu('Sender Mnemonic must be specified using -m parameter or as environemnt variable MNEMONIC');
    }

    const sender = algosdk.mnemonicToSecretKey(paramMnemonic??=process.env.MNEMONIC);
    const origDropList = sanitizeWithRemovals(await csvToJson(acctFileName), removeList);
	let [ dropList, errorDropList ] = removeAndTrackDuplicates(origDropList);
    [ dropList, errorDropList ] = removeInvalidAddresses(dropList, errorDropList);

    // create success and error streams
    let headersSuccess = Object.keys(dropList[0]);
    headersSuccess.forEach((h,i) => headersSuccess[i] = { id: h, title: h });

    const successStream = csvWriter.createObjectCsvWriter({
        path: 'successFile.csv',
        header: headersSuccess,
        append: resume,
    });

    let headersError = Object.keys(errorDropList[0]);
    headersError.forEach((h,i) => headersError[i] = { id: h, title: h });

    const errorStream = csvWriter.createObjectCsvWriter({
        path: 'errorFile.csv',
        header: headersError,
        append: resume,
    });

	const [ successDropList, errList ] = await transferTokens(sender,dropList, successStream, errorStream, groupSize);
    errorDropList = errorDropList.concat(errList);

    /*console.log('SUCCESS LIST:');
    console.log(successDropList);

    console.log('ERROR LIST:');
    console.log(errorDropList);*/

	process.exit();

})();
