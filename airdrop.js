/*
	Script to perform airdrops to accounts utilizing CSV file as data source
    WORK IN PROGRESS DO NOT USE AS-IS

	Usage: node airdrop.js -f <filename>
*/

import algosdk from 'algosdk';
import fs from 'fs';
import minimist from 'minimist';
import csv from 'fast-csv';

// TODO: Move to an external file
const blacklist = []; // list of addresses to not send to

// TODO: Move to environment variable or external file
const sender = {
    addr: 'YOUR-SENDER-ADDRESS',
    sk: 'YOUR-SENDER-SECRET-KEY'
};

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
	console.log(`Command: node airdrop.js -f <acctsfile>`);
	process.exit();
}

// TODO: validate csv
const validateFile = async (file) => {
	return true;
}

// iterate over dropList. add addresses to array. if duplicate found remove from array and add address to errorList. return errorList
const removeAndTrackDuplicates = (array) => {
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

function getFilenameArgument() {
    const args = minimist(process.argv.slice(2));
    let acctList = args.f;
    return acctList;
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

async function transferTokens(array) {
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
            "firstRound": params.lastRound,
            "lastRound": params.lastRound + 1000,
            "note": algosdk.encodeObj({ 'userType': obj.userType }),
            "amount": obj.tokenAmount,
            "genesisID": params.genesisID,
            "genesisHash": params.genesishashb64
        };

        let signedTxn = algosdk.signTransaction(txn, sender.sk);
        let txId = signedTxn.txID().toString();

        try {
            await algodClient.sendRawTransaction(signedTxn.blob).do();
            let confirmedTxn = await waitForConfirmation(algodClient, txId, 4);
            if (confirmedTxn) {
                obj.txId = txId;
                successList.push(obj);
            }
        } catch (error) {
            obj.error = error.description;
            errorList.push(obj);
        }
    }

    return { successList, errorList };
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

let acctFileName = getFilenameArgument();

/* ***********************************
   ********* Validation **************
   ***********************************
*/ 

if (acctFileName == null || acctFileName == false) exitMenu('Invalid command line arguments');

if (!fs.existsSync(acctFileName)) {
	exitMenu('Account file missing or invalid');
}

if (!validateFile(acctFileName)) {
	console.log('Accounts file invalid');
}

const algodClient = new algosdk.Algodv2("", "https://testnet-api.algonode.cloud", "");

(async () => {
	const origDropList = await csvToJson(acctFileName);
	const [ finalDropList, errorDropList ] = removeAndTrackDuplicates(origDropList);

	await transferTokens(finalDropList);

	process.exit();

})();
