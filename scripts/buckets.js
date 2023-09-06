/*

	Script to put accounts into buckets based on their balance as a percentage of total tokens

	Usage: node buckets.js

	Status: INCOMPLETE

	Todo:
		- Accept CLI parameter for maximum number of accounts
		- Loop until reaching max account
		- Write results to CSV

*/

import algosdk from 'algosdk';
import { algod, indexer } from '../include/algod.js';

(async () => {
	let balancesList = {};
	let totalTokens = 0;
	let nextToken = null;

	do {
		// Fetch accounts using the indexer (with a limit, e.g., 100 accounts per request)
		const response = await indexer.searchAccounts().limit(100).nextToken(nextToken).do();

		for (const account of response.accounts) {
			balancesList[account.address] = account.amount;
			totalTokens += account.amount;
		}

		nextToken = response['next-token'];
	} while (nextToken);

	console.log(balancesList);

	let buckets = {};

	// for each account in balances, calculate and place it in its bucket
	for (const account in balancesList) {
		const bal = balancesList[account];
		const bucket = Math.floor((bal / totalTokens) * 100);
		if (typeof buckets[bucket] == 'undefined') buckets[bucket] = [];
		
		buckets[bucket].push({
			account: account,
			amount: bal,
		});
	}

	console.log(buckets);
})();
