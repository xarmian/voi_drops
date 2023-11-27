import express from 'express';
import algosdk from 'algosdk';
import { algod } from '../include/algod.js';
import { fetchBallast } from '../include/utils.js';

const app = express();

app.get('/api/ballast', async (req, res) => {
    // get highest block from algod
    let end_block = (await algod.status().do())['last-round'];
    
    let ballast = [];

    // get ballast wallets
    try {
        ballast = (await fetchBallast()).map(account => account.account);
    }
    catch(error) {
        res.status(500).send(`Error retrieving ballast wallets from API: ${error.message}`);
        return;
    }

    // initialize an empty array to hold the addresses that voted
    let voted_ballast = [];

    // get lookback_blocks from URL parameters or use default value
    const lookback_blocks = req.query.lookback_blocks ? parseInt(req.query.lookback_blocks) : 5;

    // loop over the last five blocks
    for (let i = end_block - lookback_blocks; i <= end_block; i++) {
        // use algosdk to get a list of wallets that voted on each block
        const block = await algod.block(i).do();
        const voted = block["cert"]["vote"];

        // add the addresses that voted on this block to the voted_ballast array
        voted_ballast = voted_ballast.concat(voted.map(rec => {
            return algosdk.encodeAddress(rec["snd"]);
        }));
    }

    // remove duplicates from the voted_ballast array
    voted_ballast = [...new Set(voted_ballast)];

    // get a list of items in ballast that are not in voted_ballast
    const diff = ballast.filter(x => !voted_ballast.includes(x));

    res.json(diff);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));