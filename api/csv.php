<?php

$BLOCK_REWARD = (isset($_GET['block_reward'])) ? (float)$_GET['block_reward'] : 1.25;
$HEALTH_REWARD = (isset($_GET['health_reward'])) ? (float)$_GET['health_reward'] : 1.0;

// Step 1: Fetch data from the API
$start = urlencode($_GET['start']);
$end = urlencode($_GET['end']);
$url = "https://socksfirstgames.com/proposers/index.php?start=$start&end=$end";
$jsonData = file_get_contents($url);
$jsonDataDecoded = json_decode($jsonData, true);
$dataArray = $jsonDataDecoded['data'];

// Step 2: Calculate necessary values
$totalBlockCount = array_sum(array_column($dataArray, 'block_count'));
$totalHealthyNodeCount = $jsonDataDecoded['healthy_node_count'];

// Prepare CSV data
$csvData = [];
$csvData[] = ['account', 'userType', 'tokenAmount', 'note'];

foreach ($dataArray as $item) {
    $blockRatio = round(($item['block_count'] / $totalBlockCount) * $BLOCK_REWARD * pow(10,6));
    $healthRatio = round(($item['node']['health_divisor'] == 0 || $totalHealthyNodeCount == 0) ? 0 : ($HEALTH_REWARD / ($totalHealthyNodeCount / $item['node']['health_divisor'])) * pow(10,6));
    $sum = $blockRatio + $healthRatio;
    $note = json_encode([
        'blockRewards' => $blockRatio,
        'healthRewards' => $healthRatio,
    ]);
    $csvData[] = [$item['proposer'], 'node', $sum, $note];
}

// Step 3: Output CSV to screen
header('Content-Type: text/csv');
header('Content-Disposition: attachment; filename="rewards.csv";');
$fp = fopen('php://output', 'w');

foreach ($csvData as $row) {
    fputcsv($fp, $row);
}
fclose($fp);