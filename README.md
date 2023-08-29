This repository contains a set of scripts to perform airdrop functions for the Voi blockchain network.

There are four core scripts located in the `scripts` folder:
# Initial airdrop script - airdrop.js

Usage: `node airdrop.js -a <acctlist> [-b <blacklist>] [-g <group_size>] [-m "mnemonic"]`

# Epoch reward calculaton script - epoch_calc.js

Usage: `node epoch_calc.js -s STARTTIME -e ENDTIME -r EPOCHREWARD -f FILENAME`

# Account bucketing scirpt - buckets.js

Usage: `node buckets.js`

NOTE: buckets.js is incomplete. 

# Block finder by timestamp - find_block.js

Usage: `node find_block.js -t TIMESTAMP`
