/*
	Script to perform airdrops to accounts utilizing CSV file as data source
    mnemonic can be passed with an optional -m parameter, or set as the environment variable MNEMONIC

    WORK IN PROGRESS DO NOT USE AS-IS

	Usage: node airdrop.js -a <acctlist> [-b <blacklist>] [-g <group_size>] [-m "mnemonic"]

    Example #1: Send one transaction per line in acctList_sample.csv, using blackList_sample.csv as the blacklist

        node airdrop.js -a acctList_sample.csv -b blackList_sample.csv -m "the mnemonic of the sending account goes here"
    
    Example #2: Same as above, but send as atomic transactions with two lines from acctList_sample.csv at a time. If either
                fails, both transactions will fail and be logged to errorFile.csv

        node airdrop.js -a acctList_sample.csv -b blackList_sample.csv -g 2 -m "the mnemonic of the sending account goes here"
*/

import algosdk from 'algosdk';
import fs from 'fs';
import minimist from 'minimist';
import csvWriter from 'csv-writer';
import { sleep, exitMenu, validateFile, removeAndTrackDuplicates, removeInvalidAddresses, sanitizeWithRemovals, csvToJson } from '../include/utils.js';

const algodClient = new algosdk.Algodv2("", "https://testnet-api.algonode.cloud", "");

const getFilenameArguments = () => {
    const args = minimist(process.argv.slice(2));
    let acctList = (args.a)??=null;
    let blackList = (args.b)??=null;
    let mnemonic = (args.m)??=null;
    let testMode = (args.t)??=false;
    let groupSize = (args.g)??=1;
    return [ acctList, blackList, mnemonic, testMode, groupSize ];
}

const transferTokens = async (sender,array, successStream, errorStream, groupSize) => {
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

const waitForConfirmation = async (algodClient, txId, timeout) => {
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
