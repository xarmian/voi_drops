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

    // Check if blacklist is provided as a URL request parameter
    if (isset($_GET['blacklist'])) {
        $headers = getallheaders();
        if (isset($headers['X-Api-Key'])) { // update blacklist file
            $api_key = trim(file_get_contents('/db/api.key'));
            if ($headers['X-Api-Key'] == $api_key) {
                $newBlacklistFile = str_replace(",","\n",$_GET['blacklist']);
                file_put_contents('blacklist.csv', $newBlacklistFile);
            }
        }
        
        // use provided blacklist file
        $combinedAddresses = array_merge($combinedAddresses, explode(',',$_GET['blacklist']));        
    } else {
        // read in blacklist from blacklist.csv
        if (file_exists('blacklist.csv')) {
            $fp = fopen('blacklist.csv','r');
            while (($data = fgetcsv($fp, 0, ",")) !== FALSE) {
                if (strlen(trim($data[0])) > 0) {
                    $combinedAddresses[] = trim($data[0]);
                }
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

        $node['divisor'] = count($node['addresses']);
        if (!isset($node['addresses'])) $node['addresses'] = array();
        foreach($node['addresses'] as $address) {
            $addresses[$address][] = array(
                'node_host'=>$node['host'],
                'node_name'=>$node['name'],
                'health_score'=>$node['score'],
                'health_divisor'=>$node['divisor'],
                'health_hours'=>$node['hours'],
            );
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
$db->busyTimeout(5000);

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
else if (isset($_GET['address'])) {
    $blacklist = fetchBlacklist();

    // Prepare the SQL query to select the addresses and block counts, grouped by calendar week from Monday to Sunday
    $sql = "WITH WeekStarts AS (
                SELECT DISTINCT
                       date(timestamp, 'weekday 0', '-6 days') as week_start,
                       date(timestamp, 'weekday 0') as week_end
                FROM blocks
                WHERE proposer = :proposer
            )
            
            SELECT 
                ws.week_start as start_date,
                ws.week_end as end_date,
                COALESCE(SUM(CASE WHEN b.proposer = :proposer THEN 1 ELSE 0 END), 0) as total_blocks,
                COALESCE(COUNT(CASE WHEN b.proposer NOT IN ('" . implode("', '", $blacklist) . "') THEN b.block ELSE NULL END), 0) as count_of_rows
            FROM WeekStarts ws
            LEFT JOIN blocks b ON 
                b.timestamp BETWEEN ws.week_start AND ws.week_end
            GROUP BY 
                ws.week_start, 
                ws.week_end
            ORDER BY 
                ws.week_start";
                
    // Prepare the SQL statement and bind the parameters
    $stmt = $db->prepare($sql);
    $stmt->bindValue(':proposer', $_GET['address'], SQLITE3_TEXT);
    //$stmt->bindValue(':start', $startTimestamp, SQLITE3_TEXT);
    //$stmt->bindValue(':end', $endTimestamp, SQLITE3_TEXT);

    // Execute the SQL statement and get the results
    $results = $stmt->execute();

    // Create an array to hold the address and block count data
    $data = array();
    
    // Loop through the results and add the data to the array
    while ($row = $results->fetchArray(SQLITE3_ASSOC)) {
        var_dump($row);
        continue;
        $data[] = array(
            'week' => $row['week'],
            'block_count' => $row['block_count'],
            'total_blocks' => $row['total_blocks'],
        );
    }

    // Close the database connection
    $db->close();

    // Convert the output to a JSON object and output it
    echo json_encode($data);
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
        'nodes' => (isset($health['addresses'][$row['proposer']])) ? $health['addresses'][$row['proposer']] : array(),
    );

    // remove so we can merge in remaining nodes
    if (isset($health['addresses'][$row['proposer']])) {
        unset($health['addresses'][$row['proposer']]);
    }
}

// Add remaining nodes to the data array
foreach($health['addresses'] as $address=>$nodes) {
    $data[] = array(
        'proposer' => $address,
        'block_count' => 0,
        'nodes' => $nodes,
    );
}

// find $data['nodes'] with more than one node with a health_score >= 5.0
$extraNodeCount = 0.0;
foreach($data as $d) {
    for($i=1;$i<count($d['nodes']);$i++) {
        if ($d['nodes'][$i]['health_score'] >= 5.0) $extraNodeCount += 1.0/$d['nodes'][$i]['health_divisor'];
    }
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
    'extra_node_count' => $extraNodeCount,
);

// Convert the output to a JSON object and output it
echo json_encode($output);
?>
