<?php
header('Access-Control-Allow-Origin: *');

function fetchBlacklist() {
    $blacklistEndpoint = 'https://analytics.testnet.voi.nodly.io/v0/consensus/ballast';

    $response = file_get_contents($blacklistEndpoint);
    if (!$response) {
        throw new Exception('HTTP error!');
    }

    $jsonData = json_decode($response, true);
    $combinedAddresses = array_merge(array_keys($jsonData['bparts']), array_keys($jsonData['bots']));

    return $combinedAddresses;
}

// Get the start and end timestamps from the GET request
$startTimestamp = $_GET['start'];
$endTimestamp = $_GET['end'];

// Open the SQLite3 database
$db = new SQLite3('proposers.db');

// If the start or end timestamps are not set, return the high and low timestamps from the database
if ($startTimestamp == null || $endTimestamp == null) {
    // Get the minimum and maximum timestamps from the blocks table
    $minTimestampResult = $db->querySingle('SELECT MIN(timestamp) FROM blocks');
    $maxTimestampResult = $db->querySingle('SELECT MAX(timestamp) FROM blocks');
    $minTimestamp = $minTimestampResult ? $minTimestampResult : null;
    $maxTimestamp = $maxTimestampResult ? $maxTimestampResult : null;
    echo json_encode(array(
        'min_timestamp' => $minTimestamp,
        'max_timestamp' => $maxTimestamp
    ));
    exit();
}

// Prepare the SQL query to select the addresses and block counts
$sql = "SELECT proposer, COUNT(*) AS block_count FROM blocks WHERE timestamp >= :start AND timestamp <= :end GROUP BY proposer";

// Prepare the SQL statement and bind the parameters
$stmt = $db->prepare($sql);
$stmt->bindValue(':start', $startTimestamp, SQLITE3_TEXT);
$stmt->bindValue(':end', $endTimestamp, SQLITE3_TEXT);

// Execute the SQL statement and get the results
$results = $stmt->execute();

// Create an array to hold the address and block count data
$data = array();

// Fetch the blacklist
$blacklist = fetchBlacklist();

// Loop through the results and add the data to the array
while ($row = $results->fetchArray(SQLITE3_ASSOC)) {
    if (in_array($row['proposer'], $blacklist)) {
        continue;
    }
    $data[] = array(
        'proposer' => $row['proposer'],
        'block_count' => $row['block_count']
    );
}

// Get the most recent timestamp from the blocks table
$maxTimestampResult = $db->querySingle('SELECT MAX(timestamp) FROM blocks');
$maxTimestamp = $maxTimestampResult ? $maxTimestampResult : null;

// Get highest block from blocks table
$blockHeightResult = $db->querySingle('SELECT MAX(block) FROM blocks');

// Close the database connection
$db->close();

// Add the most recent timestamp to the output array
$output = array(
    'data' => $data,
    'max_timestamp' => $maxTimestamp,
    'block_height' => $blockHeightResult,
);

// Convert the output to a JSON object and output it
echo json_encode($output);
?>
