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

    // read in blacklist from blacklist.csv
   if (file_exists('blacklist.csv')) {
	   $fp = fopen('blacklist.csv','r');
	   while (($data = fgetcsv($fp, 0, ",")) !== FALSE) {
	      if (strlen(trim($data[0])) > 0) {
        	 $combinedAddresses[] = trim($data[0]);
	      }
	   }
    }
    return $combinedAddresses;
}

function fetchWeeklyHealth($blacklist, $date) {
    $healthDir = '/app/proposers/history';
    $healthFiles = glob($healthDir . '/health_week_*.json');
    rsort($healthFiles);
    $latestFile = null;

    foreach ($healthFiles as $file) {
        if (filesize($file) > 1024) {
            $fileDate = substr(basename($file, '.json'), -8);
            if ($fileDate <= $date) {
                $latestFile = $file;
                break;
            }
        }
    }

    if (!$latestFile) {
        $data = array();
    }
    else {
        $response = file_get_contents($latestFile);
        if (!$response) {
            throw new Exception('HTTP error!');
        }

        $jsonData = json_decode($response, true);

        $meta = $jsonData['meta'];
        $data = $jsonData['data'];

        $positions = array('host'=>null,'name'=>null,'score'=>null,'addresses'=>array());
        foreach($meta as $pos=>$m) {
            $positions[$m['name']] = $pos;
        }
    }

    $nodes = array();
    $totalNodeCount = 0;
    $healthyNodeCount = 0;
    $qualifyNodeCount = 0;
    $emptyNodeCount = 0;

    foreach($data as $d) {
        foreach($d[$positions['addresses']] as $pos=>$address) {
            if (in_array($address, $blacklist)) {
                unset($d[$positions['addresses']][$pos]);
            }
        }

        $nodes[] = array(
            'host' => $d[$positions['host']],
            'name' => $d[$positions['name']],
            'score' => $d[$positions['score']],
            'addresses' => $d[$positions['addresses']],
            'hours' => $d[$positions['hours']]
        );

        if ($d[$positions['score']] >= 5.0) {
            $healthyNodeCount++;
            if ((int)$d[$positions['hours']] >= 168) {
                 $qualifyNodeCount++;
            }

        }

        $totalNodeCount++;
    }

    // map $nodes array to use addresses as keys
    $addresses = array();
    foreach($nodes as $node) {
        if (count($node['addresses']) == 0 && $node['score'] >= 5.0) {
            $emptyNodeCount++;
        }
        foreach($node['addresses'] as $address) {
            if (isset($addresses[$address])) {
                $addresses[$address]['divisor'] = min(count($node['addresses']),$addresses[$address]['divisor']);
            }
            else {
                $addresses[$address] = $node;
                $addresses[$address]['divisor'] = count($node['addresses']);
                unset($addresses[$address]['addresses']);
            }
        }
    }

    return array(
        'addresses'=>$addresses,
        'total_node_count'=>$totalNodeCount,
        'healthy_node_count'=>$healthyNodeCount,
        'empty_node_count'=>$emptyNodeCount,
        'qualify_node_count'=>$qualifyNodeCount,
    );
}

// Get the start and end timestamps from the GET request
$startTimestamp = (isset($_GET['start'])) ? $_GET['start'].'T00:00:00Z' : null;
$endTimestamp = (isset($_GET['end'])) ? $_GET['end'].'T23:59:59Z' : null;

// Open the SQLite3 database
$db = new SQLite3('/db/proposers.db');

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

// Fetch weekly health data
$health = fetchWeeklyHealth($blacklist,date('Ymd', strtotime('+1 day', strtotime($endTimestamp))));

// Loop through the results and add the data to the array
while ($row = $results->fetchArray(SQLITE3_ASSOC)) {
    if (in_array($row['proposer'], $blacklist)) {
        continue;
    }
    $data[] = array(
        'proposer' => $row['proposer'],
        'block_count' => $row['block_count'],
        'node' => array(
            'node_host' => isset($health['addresses'][$row['proposer']]) ? $health['addresses'][$row['proposer']]['host'] : null,
            'node_name' => isset($health['addresses'][$row['proposer']]) ? $health['addresses'][$row['proposer']]['name'] : null,
            'health_score' => isset($health['addresses'][$row['proposer']]) ? $health['addresses'][$row['proposer']]['score'] : null,
            'health_divisor' => isset($health['addresses'][$row['proposer']]) ? $health['addresses'][$row['proposer']]['divisor'] : null,
            'health_hours' => isset($health['addresses'][$row['proposer']]) ? $health['addresses'][$row['proposer']]['hours'] : null,
        ),
    );

    // remove so we can merge in remaining nodes
    if (isset($health['addresses'][$row['proposer']])) {
        unset($health['addresses'][$row['proposer']]);
    }
}

// Add remaining nodes to the data array
foreach($health['addresses'] as $address=>$node) {
    $data[] = array(
        'proposer' => $address,
        'block_count' => 0,
        'node' => array(
            'node_host' => $node['host'],
            'node_name' => $node['name'],
            'health_score' => $node['score'],
            'health_divisor' => $node['divisor'],
            'health_hours' => $node['hours'],
        ),
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
    'total_node_count' => $health['total_node_count'],
    'healthy_node_count' => $health['healthy_node_count'],
    'empty_node_count' => $health['empty_node_count'],
    'qualify_node_count' => $health['qualify_node_count'],
);

// Convert the output to a JSON object and output it
echo json_encode($output);
?>
