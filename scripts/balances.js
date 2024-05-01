/*

	Script to snapshot Voi and Via balances and output to a CSV file

	Usage: npm run balances -- -a [account] [-r round] [-b blacklist.csv]

	All parameters are optional:
	- If no account is provided, script will iterate and snapshot balances for all accounts
	- If no round is provided, script will snapshot the current round
	- If no blacklist is provided, script will not filter out any accounts

*/

import { algod, indexer } from '../include/algod.js';
import { writeToCSV, csvToJson, validateFile } from '../include/utils.js';
import { arc200 } from "ulujs";
import fs from 'fs';
import minimist from 'minimist';

const VIA_ID = 6779767;
const zeroAddr = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ";
const ci = new arc200(VIA_ID, algod, indexer);
const decimalDivisor = 1000000;

const getFilenameArguments = () => {
    const args = minimist(process.argv.slice(2));
    let checkRound = (args.r)??=null;
    let blacklistFileName = (args.b)??=null;
	let acct = (args.a)??=null;
    return [ checkRound, blacklistFileName, acct ];
}

function getAllTransactions(txns) {
    let payments = [];
    if (txns === undefined) return payments;
    for (const t of txns) {
        payments.push(t);
        if (t['inner-txns']) payments = payments.concat(getAllTransactions(t['inner-txns']));
    }
    
    return payments;
}

(async () => {
	const [ checkRound, blacklistFileName, acct ] = getFilenameArguments();

	// get current round from algod
	const status = await algod.status().do();
	const currentRound = status['last-round'];

	console.log(`Performing snapshot at round ${checkRound ?? currentRound}`);

    let blacklist = []; // list of addresses to not send to
    if (blacklistFileName != null && blacklistFileName != false) {
        if (fs.existsSync(blacklistFileName) && validateFile(blacklistFileName)) {
            blacklist = await csvToJson(blacklistFileName);
        }

		console.log(`Loaded ${blacklist.length} blacklisted accounts from ${blacklistFileName}`);
    }

	// map blacklist to array of addresses
	blacklist = blacklist.map(item => item.account);

	// get metadata -- THANKS SHELLY (code borrowed from https://github.com/NautilusOSS/arc200-snapshot)
	const arc200_nameR = await ci.arc200_name();
	if (!arc200_nameR.success) {
		console.error("Error getting metadata");
		process.exit(1);
	}
	const arc200_name = arc200_nameR.returnValue;
	const arc200_symbolR = await ci.arc200_symbol();
	if (!arc200_symbolR.success) {
		console.error("Error getting metadata");
		process.exit(1);
	}
	const arc200_symbol = arc200_symbolR.returnValue;
	const arc200_decimalsR = await ci.arc200_decimals();
	if (!arc200_decimalsR.success) {
		console.error("Error getting metadata");
		process.exit(1);
	}
	const arc200_decimals = arc200_decimalsR.returnValue;
	const arc200_totalSupplyR = await ci.arc200_totalSupply();
	if (!arc200_totalSupplyR.success) {
		console.error("Error getting metadata");
		process.exit(1);
	}
	const arc200_totalSupply = arc200_totalSupplyR.returnValue;

	const token = {
		VIA_ID,
		name: arc200_name,
		symbol: arc200_symbol,
		decimals: Number(arc200_decimals),
		totalSupply: arc200_totalSupply.toString(),
	};

	if (!fs.existsSync("data")) {
		fs.mkdirSync("data");
	  }
	  
	  // if arc200_Transfer.json does not exist then create it
	  if (!fs.existsSync(`data/arc200_Transfer_${token.symbol}.json`)) {
		fs.writeFileSync(
		  `data/arc200_Transfer_${token.symbol}.json`,
		  JSON.stringify([])
		);
	  }
	  
	  const stored_arc200_Transfer = JSON.parse(
		fs.readFileSync(`data/arc200_Transfer_${token.symbol}.json`, "utf8")
	  );
	  
	  const lastRound = stored_arc200_Transfer.reduce(
		(acc, val) => (acc[1] > val[1] ? acc[1] : val[1]),
		0
	  );
	  
	  const arc200_TransferR = await ci.arc200_Transfer({
		minRound: lastRound > 0 ? lastRound + 1 : 0,
	  });
	  
	  stored_arc200_Transfer.push(...arc200_TransferR);
	  
	  fs.writeFileSync(
		`data/arc200_Transfer_${token.symbol}.json`,
		JSON.stringify(
		  stored_arc200_Transfer,
		  (k, v) => (typeof v === "bigint" ? v.toString() : v),
		  2
		)
	  );	  


	const genesisBalances = {};

	if (checkRound != null) {
		// assign VOI balances at genesis
		const genesisAccounts = (await algod.genesis().do()).alloc;

		for (const account of genesisAccounts) {
			genesisBalances[account.addr] = BigInt(account.state.algo)
		}
	}

	console.log(`Retrieving VOI balances...`);

	let balancesList = {};
	let nextToken = null;
	let skipList = [];

	do {
		// Fetch accounts using the indexer (with a limit, e.g., 100 accounts per request)
		let response = {};
		if (acct != null) {
			const accountResp = await indexer.lookupAccountByID(acct).do();
			response = {
				accounts: [accountResp.account],
			};
		}
		else {
			response = await indexer.searchAccounts().nextToken(nextToken).do();
		}

		for (const account of response.accounts) {
			// check if account is in blacklist
			if (blacklist.includes(account.address) || account.address.substring(0, 4) === 'SPAM' || account.address.substring(0,6) === 'STRESS') {
				continue;
			}

			process.stdout.write(`Retrieving balance for ${account.address}`);

			if (checkRound == null) {
				// get the balance of the account at the current round
				/*const accountInfo = await indexer.lookupAccountByID(account.address).do();
				balancesList[account.address] = {
					voiBalance: BigInt(accountInfo['account'].amount),
					viaBalance: BigInt(0),
				}
				*/
				balancesList[account.address] = {
					voiBalance: BigInt(account.amount??0),
					viaBalance: BigInt(0),
				}
			}
			else {
				// get all transactions for the account and calculate balance
				let balance = BigInt(0);
				let nextToken = null;
				let numIterations = 0;

				do {
					numIterations++;
					process.stdout.write('.');

					const transactions = await indexer.searchForTransactions()
						.address(account.address)
						.maxRound(Number(checkRound))
						.nextToken(nextToken)
						.limit(500)
						.do();

					const txns = getAllTransactions(transactions.transactions);

					for (const tx of txns) {
						if (tx['sender'] === account.address) {
							balance -= BigInt(tx['payment-transaction']?.amount ?? 0) + BigInt(tx['fee'] ?? 0);
						}
						if (tx['payment-transaction']?.receiver === account.address) {
							balance += BigInt(tx['payment-transaction']?.amount ?? 0);
						}
						if (tx['payment-transaction']?.['close-remainder-to'] === account.address) {
							balance += BigInt(tx['payment-transaction']?.['close-amount'] ?? 0);
						}
					}

					nextToken = transactions['next-token'];

					if (acct == null && numIterations > 200) {
						console.log('');
						console.log(`Account ${account.address} has more than ${numIterations * 500} transactions at round ${checkRound}`);
						skipList.push(account.address);
						break;
					}
				} while (nextToken);
				console.log('');

				balancesList[account.address] = {
					voiBalance: (genesisBalances[account.address]??BigInt(0)) + balance,
					viaBalance: BigInt(0),
				};
			}
		}

		nextToken = response['next-token'];
	} while (nextToken);

	console.log(`Snapshot of ${Object.keys(balancesList).length} VOI Account Balances completed`);

	const balance = new Map();

	let round = (checkRound == null) ? Number.MAX_SAFE_INTEGER : checkRound;
	balance.set(zeroAddr, BigInt(token.totalSupply));
	for (const [
	  txID,
	  time,
	  ts,
	  from,
	  to,
	  amount,
	] of stored_arc200_Transfer.filter((el) => el[1] <= round)) {
	  if (!balance.has(from)) {
		balance.set(from, BigInt(0));
	  }
	  if (!balance.has(to)) {
		balance.set(to, BigInt(0));
	  }
	  balance.set(from, balance.get(from) - BigInt(amount));
	  balance.set(to, balance.get(to) + BigInt(amount));
	}

	if (acct != null) {
		// output the account's calculated balances to the console
		const viaBalance = balance.get(acct)??BigInt(0);
		console.log(`Account: ${acct}`);
		console.log(`VOI: ${Number(balancesList[acct].voiBalance)/decimalDivisor}`);
		console.log(`VIA: ${Number(viaBalance)/decimalDivisor}`);
		console.log(`Total: ${Number(balancesList[acct].voiBalance + viaBalance)/decimalDivisor}`);
		process.exit();
	}

	// output number of balance entries
	console.log(`Calculated Snapshot of VIA balances for ${balance.size} accounts`);
  
	// for each account in balance map, add the amount to the viaBalance property in balancesList
	for (const [account, amount] of balance.entries()) {
		if (!balancesList[account]) {
			balancesList[account] = {
				voiBalance: BigInt(0),
				viaBalance: BigInt(0),
			};
		}
		balancesList[account].viaBalance = amount;
	}

	// remove blacklist accounts from balancesList
	for (const account of blacklist) {
		delete balancesList[account];
	}

	// sort balancesList by sum of viaBalance and voiBalance
	const sortedBalances = Object.entries(balancesList).sort((a, b) => {
		const sumA = a[1].voiBalance + a[1].viaBalance;
		const sumB = b[1].voiBalance + b[1].viaBalance;

		if (sumB > sumA) {
			return 1;
		} else if (sumB < sumA) {
			return -1;
		} else {
			return 0;
		}
	});

	let voiTotal = BigInt(0);
	let viaTotal = BigInt(0);

	// calculate total voi and via balances
	for (const [, { voiBalance, viaBalance }] of sortedBalances) {
		voiTotal += voiBalance;
		viaTotal += viaBalance;
	}

	// filter out zeroAddress from sortedBalances
	const zeroIndex = sortedBalances.findIndex(([account]) => account === zeroAddr);
	const zeroBalance = sortedBalances.splice(zeroIndex, 1);

	// convert sortedBalances to an array of objects
	let sortedBalancesArray = sortedBalances.map(([account, { voiBalance, viaBalance }]) => ({
		account,
		userType: 'snapshot',
		voiBalance: voiBalance.toString(),
		viaBalance: viaBalance.toString(),
		totalBalance: (voiBalance + viaBalance).toString(),
		notes: JSON.stringify({ voi: (Number(voiBalance)/decimalDivisor), via: (Number(viaBalance)/decimalDivisor), total: (Number(voiBalance + viaBalance)/decimalDivisor) }),
	}));

	// if an account is in skipList, change the voiBalance to 0
	for (const account of skipList) {
		const index = sortedBalancesArray.findIndex(({ account: addr }) => addr === account);
		sortedBalancesArray[index].voiBalance = '0';
		sortedBalancesArray[index].totalBalance = sortedBalancesArray[index].viaBalance;
		sortedBalancesArray[index].notes = JSON.stringify({ voi: 0, via: (Number(sortedBalancesArray[index].viaBalance)/decimalDivisor), total: (Number(sortedBalancesArray[index].viaBalance)/decimalDivisor) });
	}

	// create a new array with only the skipped accounts and output to balances_skipped.csv
	const skippedBalances = sortedBalancesArray.filter(({ account }) => skipList.includes(account));
	await writeToCSV(skippedBalances, 'balances_skipped.csv');

	// remove skippedBalances accounts from sortedBalancesArray
	sortedBalancesArray = sortedBalancesArray.filter(({ account }) => !skipList.includes(account));

	// write sortedBalancesArray to CSV
	await writeToCSV(sortedBalancesArray,'balances.csv');

	console.log(`Total VOI: ${voiTotal}`);
	console.log(`Total VIA: ${viaTotal}`);

	// undistributed VOI and VIA
	const undistributedVOI = zeroBalance[0][1].voiBalance;
	const undistributedVIA = zeroBalance[0][1].viaBalance;

	console.log(`Undistributed VOI: ${undistributedVOI}`);
	console.log(`Undistributed VIA: ${undistributedVIA}`);

	if (skipList.length > 0) {
		console.log('');
		console.log(`Skipped ${skipList.length} accounts with more than 100,000 transactions:`);
		for (const account of skipList) {
			console.log(` ${account}`);
		}
	}
  
})();
