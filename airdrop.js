/*
	Script to perform airdrops to accounts utilizing CSV file as data source
    mnemonic can be passed with an optional -m parameter, or set as the environment variable MNEMONIC

    WORK IN PROGRESS DO NOT USE AS-IS

	Usage: node airdrop.js -a <acctlist> -b <blacklist> [-m "mnemonic"]
*/

import algosdk from 'algosdk';
import fs from 'fs';
import minimist from 'minimist';
import csv from 'fast-csv';

const algodClient = new algosdk.Algodv2("", "https://testnet-api.algonode.cloud", "");

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
	console.log(`Command: node airdrop.js -a <acctlist> -b <blacklist> [-m "mnemonic of sender"]`);
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
const sanitizeWithBlacklist = (array, blacklist) => {
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
    return [ acctList, blackList, mnemonic ];
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

async function transferTokens(sender,array) {
    let successList = [];
    let errorList = [];
    const params = await algodClient.getTransactionParams().do();

    for (let i = 0; i < array.length; i++) {
        if (i % 10 === 0) {
            await sleep(1000);  // pause for a second after every 10 transactions
        }

        let obj = array[i];
        let txn = {
            "from": sender.addr,
            "to": obj.account,
            "fee": params.fee,
            "firstRound": params.firstRound,
            "lastRound": params.lastRound,
            "note": algosdk.encodeObj({ 'userType': obj.userType }),
            "amount": parseInt(obj.tokenAmount),
            "genesisID": params.genesisID,
            "genesisHash": params.genesisHash
        };

        let signedTxn = algosdk.signTransaction(txn, sender.sk);
        const txId = signedTxn.txID

        try {
            await algodClient.sendRawTransaction(signedTxn.blob).do();
            let confirmedTxn = await waitForConfirmation(algodClient, txId, 4);
            if (confirmedTxn) {
                obj.txId = txId;
                successList.push(obj);
            }
        } catch (error) {
            obj.error = error.response.body.message;
            errorList.push(obj);
        }
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
    let [ acctFileName, blacklistFileName, paramMnemonic ] = getFilenameArguments();

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

    // handle senderMnemonic
    if (typeof process.env.MNEMONIC == 'undefined' && paramMnemonic == null) {
        exitMenu('Sender Mnemonic must be specified using -m parameter or as environemnt variable MNEMONIC');
    }

    const sender = algosdk.mnemonicToSecretKey(paramMnemonic??=process.env.MNEMONIC);
    const origDropList = sanitizeWithBlacklist(await csvToJson(acctFileName), blacklist);
	let [ dropList, errorDropList ] = removeAndTrackDuplicates(origDropList);
    [ dropList, errorDropList ] = removeInvalidAddresses(dropList, errorDropList);

	const [ successList, errList ] = await transferTokens(sender,dropList);
    errorDropList.concat(errList);

    console.log('SUCCESS LIST:');
    console.log(successList);

    console.log('ERROR LIST:');
    console.log(errorDropList);

	process.exit();

})();
