/*

	Script to put accounts into buckets based on their balance as a percentage of total tokens

	Usage: node buckets.js

	Status: INCOMPLETE

	Todo:
		- Accept CLI parameter for maximum number of accounts
		- Loop until reaching max account
		- Write results to CSV

*/

import { algod, indexer } from '../include/algod.js';
import { writeToCSV } from '../include/utils.js';
import { arc200 } from "ulujs";
import fs from 'fs';

const VIA_ID = 6779767;
const zeroAddr = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ";
const ci = new arc200(VIA_ID, algod, indexer);
const decimalDivisor = 1000000;


(async () => {

	// get metadata
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
	  
	  console.log("Last Round", lastRound);
	  
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

	let balancesList = {};
	let nextToken = null;

	do {
		// Fetch accounts using the indexer (with a limit, e.g., 100 accounts per request)
		const response = await indexer.searchAccounts().limit(100).nextToken(nextToken).do();

		for (const account of response.accounts) {
			balancesList[account.address] = {
				voiBalance: BigInt(account.amount),
				viaBalance: BigInt(0),
			}
		}

		nextToken = response['next-token'];
	} while (nextToken);

	const balance = new Map();

	let round = Number.MAX_SAFE_INTEGER;
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
	const sortedBalancesArray = sortedBalances.map(([account, { voiBalance, viaBalance }]) => ({
		account,
		'userType:': 'snapshot',
		//voiBalance: voiBalance.toString(),
		//viaBalance: viaBalance.toString(),
		totalBalance: (voiBalance + viaBalance).toString(),
		notes: JSON.stringify({ voi: (Number(voiBalance)/decimalDivisor), via: (Number(viaBalance)/decimalDivisor), total: (Number(voiBalance + viaBalance)/decimalDivisor) }),
	}));

	// write sortedBalancesArray to CSV
	await writeToCSV(sortedBalancesArray,'balances.csv');

	console.log(`Total VOI: ${voiTotal}`);
	console.log(`Total VIA: ${viaTotal}`);

	// undistributed VOI and VIA
	const undistributedVOI = zeroBalance[0][1].voiBalance;
	const undistributedVIA = zeroBalance[0][1].viaBalance;

	console.log(`Undistributed VOI: ${undistributedVOI}`);
	console.log(`Undistributed VIA: ${undistributedVIA}`);
  
})();
