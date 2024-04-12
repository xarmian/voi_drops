/*
	Script to perform airdrops to accounts utilizing CSV file as data source
    mnemonic can be passed with an optional -m parameter, or set as the environment variable MNEMONIC

    WORK IN PROGRESS DO NOT USE AS-IS

	Usage: node airdrop.js -a <acctlist> [-t] [-b <blacklist>] [-g <group_size>] [-m "mnemonic"] [-n "note"]

    Example #1: Send one transaction per line in acctList_sample.csv, using blackList_sample.csv as the blacklist

        node airdrop.js -a acctList_sample.csv -b blackList_sample.csv -m "the mnemonic of the sending account goes here"
    
    Example #2: Same as above, but send as atomic transactions with two lines from acctList_sample.csv at a time. If either
                fails, both transactions will fail and be logged to errorFile.csv

        node airdrop.js -a acctList_sample.csv -b blackList_sample.csv -g 2 -m "the mnemonic of the sending account goes here" -n "this is a note"

    TO DO: 
    - Calculate and display total number of tokens to be sent
    - Calculate and display total number of wallets to be sent

*/

import algosdk from 'algosdk';
import fs from 'fs';
import minimist from 'minimist';
import csvWriter from 'csv-writer';
import { algod, indexer } from '../include/algod.js';
import { sleep, fetchBlacklist, validateFile, removeAndTrackDuplicates, removeInvalidAddresses, sanitizeWithRemovals, csvToJson } from '../include/utils.js';
import Contract from 'arc200js';

const FLAT_FEE = 1000; // flat fee amount, 1000 microvoi == .001 voi

const atomicToDisplay = (amount, decimals) => {
    if (decimals === undefined) decimals = 6;
    return amount / Math.pow(10, decimals);
}

// show help menu and exit
const exitMenu = (err) => {
	if (err) console.log(`ERROR: ${err}`);
	console.log(`Usage: node airdrop.js -a <acctlist> [-b <blacklist>] [-g <group_size>] [-m "mnemonic of sender"]`);
	process.exit();
}

const getFilenameArguments = () => {
    const args = minimist(process.argv.slice(2));
    let acctList = (args.a)??=null;
    let blackList = (args.b)??=null;
    let mnemonic = (args.m)??=null;
    let testMode = (args.t)??=false;
    let note = (args.n)??='';
    let groupSize = (args.g)??=1;
    let arc200TokenId = (args.v)??=null;
    return [ acctList, blackList, mnemonic, testMode, groupSize, note, arc200TokenId ];
}

const transferTokens = async (sender,array, successStream, errorStream, groupSize, testMode, note, contract) => {
    let successList = [];
    let errorList = [];
    const enc = new TextEncoder();

    const params = await algod.getTransactionParams().do();
    params.fee = FLAT_FEE;
    params.flatFee = true;

    let txGroup = [];
    let objInGroup = [];
    if (groupSize < 1) groupSize = 1;

    for (let i = 0; i < array.length; i++) {
        try {
            let obj = array[i];

            if (contract != null) {
                if (testMode) {
                    console.log(`Test mode: Transfer from ${obj.tokenAmount} to ${obj.account}, ${obj.tokenAmount}`);
                }
                else {
                    const resp = await contract.arc200_transfer(obj.account, BigInt(obj.tokenAmount), false, false);

                    obj.txId = resp.txId;
                    successList = [obj];
                    await successStream.writeRecords(successList);
                }
            }
            else {
                // skip zero token amounts
                if (obj.tokenAmount > 0) {
                    if (obj.note !== undefined && note !== undefined) {
                        try {
                            obj.note = JSON.parse(obj.note);
                            obj.note['note'] = note;
                            obj.note = JSON.stringify(obj.note);
                        } catch (e) {
                            // obj.note is not json, ignore
                        }
                    }

                    const txn = algosdk.makePaymentTxnWithSuggestedParams(sender.addr, obj.account, parseInt(obj.tokenAmount), undefined, enc.encode(obj.note || note),params);
                    // Using the receiver transaction as a lease
                    // This prevents the airdrop script from sending a rewards payment twice in a 1000 round range
                    txn.lease = algosdk.decodeAddress(obj.account).publicKey;

                    txGroup.push(txn);
                    objInGroup.push(obj);
                }
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

                if (testMode) {
                    for (let o of objInGroup) {
                        successList.push(o);
                        console.log(`Test mode: Sent ${o.tokenAmount} to ${o.account}`);
                    }
                }
                else {
                    const { txId } = await algod.sendRawTransaction(signedTxns).do();
                    let confirmedTxn = await waitForConfirmation(algod, txId, 8);
                    if (confirmedTxn) {
                        for (let o of objInGroup) {
                            successList.push(o);
                            console.log(`Sent ${o.tokenAmount} to ${o.account}`);
                        }

                        await successStream.writeRecords(objInGroup);
                    }
                }
            }
        } catch (error) {
            for (let o of objInGroup) {
                o.error = (error && error.response && error.response.body && error.response.body.message) ? error.response.body.message : error.toString().substring(0,40);
                errorList.push(o);
                console.log(`Error sending ${o.tokenAmount} to ${o.account}: ${o.error}`);
            }
            await errorStream.writeRecords(objInGroup);
        }

        txGroup = [];
        objInGroup = [];
    }
    return [ successList, errorList ];
}

const waitForConfirmation = async (algod, txId, timeout) => {
    let startTime = new Date().getTime();
    let txInfo = await algod.pendingTransactionInformation(txId).do();
    while (txInfo['confirmed-round'] === null && new Date().getTime() - startTime < timeout * 1000) {
        sleep(1000);
        txInfo = await algod.pendingTransactionInformation(txId).do();
    }
    if (txInfo['confirmed-round'] !== null) {
        return txInfo;
    }
    return null;
}

(async () => {
    let [ acctFileName, blacklistFileName, paramMnemonic, testMode, groupSize, note, arc200TokenId ] = getFilenameArguments();

    // handle accotFileName
    if (acctFileName == null || acctFileName == false) exitMenu('Invalid command line arguments');
    if (!fs.existsSync(acctFileName)) {
        exitMenu('Account file missing or invalid');
    }
    
    if (!validateFile(acctFileName)) {
        exitMenu('Accounts file invalid');
    }
    
    // handle senderMnemonic
    if (typeof process.env.MNEMONIC == 'undefined' && paramMnemonic == null) {
        exitMenu('Sender Mnemonic must be specified using -m parameter or as environemnt variable MNEMONIC');
    }

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

    let alreadySent = [];
    let resume = false;

    const currentDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const successFileName = `successFile_${currentDate}.csv`;

    if (fs.existsSync(successFileName) && validateFile(successFileName)) {
        resume = true;
        alreadySent = await csvToJson(successFileName);
    }

    const removeList = blacklist.concat(alreadySent);

    const sender = algosdk.mnemonicToSecretKey(paramMnemonic??=process.env.MNEMONIC);
    const origDropList = sanitizeWithRemovals(await csvToJson(acctFileName), removeList);

    const senderAccountInfo = await algod.accountInformation(sender.addr).do();
    console.log(`Sender account ID: ${sender.addr}`);
    console.log(`Sender balance: ${atomicToDisplay(senderAccountInfo.amount)}`);

    let contract = null;
    let arcBal = null;
    let decimals = 6;

    // display token info if arc200TokenId is specified
    if (arc200TokenId != null) {
        try {
            const opts = {
                acc: sender,
                simulate: false,
                waitForConfirmation: true,
            };
            contract = new Contract(arc200TokenId, algod, indexer, opts);
            arcBal = await contract.arc200_balanceOf(sender.addr);
            
            if (arcBal.error) throw new Error(arcBal.error);
            console.log(`Sender ARC200 balance: ${arcBal.returnValue}`)

            const metaData = (await contract.getMetadata()).returnValue;
            console.log();
            console.log(`ARC200 Metadata for token ID ${arc200TokenId}:`);
            console.log(` Name: ${metaData.name}`);
            console.log(` Symbol: ${metaData.symbol}`);
            console.log(` Total Supply: ${metaData.totalSupply}`);
            console.log(` Decimals: ${metaData.decimals}`);
            console.log();

            decimals = Number(metaData.decimals);

        }
        catch (error) {
            console.log(`Error retrieving ARC200 token info: ${error}`);
        }
    }

    let [ dropList, errorDropList ] = removeAndTrackDuplicates(origDropList);
    [ dropList, errorDropList ] = removeInvalidAddresses(dropList, errorDropList);

    // check senderAccountInfo.amount against total tokens to be sent
    let totalTokens = 0;
    for (let obj of dropList) {
        totalTokens += Number(obj.tokenAmount);
    }

    const count = dropList.filter(item => item.tokenAmount > 0).length;
    const estimateTxFees = count * FLAT_FEE;

    // adding one to totalTokens to account for transaction fee
    if (senderAccountInfo.amount < (totalTokens+estimateTxFees)) {
       // exitMenu(`Sender account balance (${senderAccountInfo.amount}) is less than total tokens to be sent (${totalTokens})`);
    };

    // display total tokens to be sent
    console.log(`Total tokens to be sent: ${atomicToDisplay(totalTokens,decimals)}`);
    console.log(`Estimated tx fees: ${atomicToDisplay(estimateTxFees)}`);
    console.log(`Total wallets: ${dropList.length}`);
    console.log(`Number of wallets with token amount greater than zero: ${count}`);
    console.log('');

    if (count == 0) {
        console.log('No accounts to sent to. Exiting...');
        process.exit();
    }
    
    // pause for enter key press to continue
    console.log('Press ENTER to continue, Q to quit...');
    await new Promise(resolve => {
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on('data', function listener(chunk) {
            process.stdin.pause();
            process.stdin.removeListener('data', listener);
            if (chunk.toString() !== '\r' && chunk.toString() !== '\n') {
                process.exit();
            } else {
                resolve();
            }
        });
    });

    // create success and error streams
    let headersSuccess = Object.keys(dropList[0]);
    headersSuccess.forEach((h,i) => headersSuccess[i] = { id: h, title: h });
    headersSuccess.push({ id: 'txId', title: 'txId' });

    const successStream = csvWriter.createObjectCsvWriter({
        path: successFileName,
        header: headersSuccess,
        append: resume,
    });

    let headersError = Object.keys(dropList[0]);
    headersError.forEach((h,i) => headersError[i] = { id: h, title: h });
    headersError.push({ id: 'error', title: 'error' });

    const errorStream = csvWriter.createObjectCsvWriter({
        path: 'errorFile.csv',
        header: headersError,
        append: resume,
    });

	const [ successDropList, errList ] = await transferTokens(sender,dropList, successStream, errorStream, groupSize, testMode, note, contract);
    errorDropList = errorDropList.concat(errList);

	process.exit();

})();
