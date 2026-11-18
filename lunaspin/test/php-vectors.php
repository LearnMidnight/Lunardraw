<?php
// Checks the PHP twin against test/vectors.json (the same answers the JS rules give).
// Run: php test/php-vectors.php
require __DIR__ . '/../php/lunaspin-core.php';

$v    = json_decode( file_get_contents( __DIR__ . '/vectors.json' ), true, 512, JSON_THROW_ON_ERROR );
$pass = 0;
$fail = 0;
function check( string $what, $got, $want ): void {
	global $pass, $fail;
	if ( $got === $want ) {
		$pass++;
	} else {
		$fail++;
		fwrite( STDERR, "FAIL {$what}\n  got  " . json_encode( $got, JSON_UNESCAPED_UNICODE ) . "\n  want " . json_encode( $want, JSON_UNESCAPED_UNICODE ) . "\n" );
	}
}

$has_nfc = class_exists( 'Normalizer' );
foreach ( $v['tidy'] as $i => $t ) {
	if ( ! $has_nfc && preg_match( '/\x{0301}/u', $t['in'] ) ) {
		continue; // NFC needs intl; the browser does it, the server then only checks.
	}
	check( "tidy #{$i}", lunaspin_tidy( $t['in'] ), $t['out'] );
}
foreach ( $v['listCommitment'] as $i => $t ) {
	check( "listCommitment #{$i}", lunaspin_list_commitment( $t['items'] ), $t['hash'] );
}
foreach ( $v['rules'] as $i => $t ) {
	check( "rulesList #{$i}", lunaspin_rules_list( $t['rules'] ), $t['list'] );
	check( "rules #{$i}", lunaspin_rules_commitment( $t['rules'] ), $t['hash'] );
}
foreach ( $v['entryHash'] as $i => $t ) {
	check( "entryHash #{$i}", lunaspin_entry_hash( $t['salt'], $t['name'] ), $t['hash'] );
}
foreach ( $v['words'] as $i => $t ) {
	check( "randomWord #{$i}", bin2hex( lunaspin_random_word( hex2bin( $t['output'] ), $t['index'] ) ), $t['word'] );
}
foreach ( $v['uniform'] as $i => $t ) {
	check( "uniformInt #{$i} (n={$t['n']})", (string) lunaspin_uniform_int( hex2bin( $t['word'] ), (int) $t['n'] ), $t['value'] );
}
foreach ( $v['spins'] as $i => $t ) {
	$lock = lunaspin_lock_spin( $t );
	check( "spin #{$i} list", $lock['listFp'], $t['listFp'] );
	check( "spin #{$i} rules", $lock['rulesFp'], $t['rulesFp'] );
	check( "spin #{$i} seed", $lock['seed'], $t['seed'] );
	check( "spin #{$i} result", lunaspin_result_indexes( $t['output'], $t['rules'], count( $t['names'] ) ), $t['result'] );
}
foreach ( $v['teams'] as $i => $t ) {
	check( "teams #{$i}", lunaspin_teams_of( $t['order'], $t['teams'] ), $t['out'] );
}
foreach ( array( array( 'mode' => 'shuffle', 'list' => 'private' ), array( 'mode' => 'pick-many', 'count' => 1 ), array( 'mode' => 'weighted' ), array( 'mode' => 'teams', 'teams' => 3, 'list' => 'private' ), array( 'mode' => 'teams', 'teams' => 1 ), array( 'mode' => 'teams', 'teams' => 51 ), array( 'mode' => 'teams' ) ) as $bad ) {
	try {
		lunaspin_check_rules( $bad );
		check( 'refuses ' . json_encode( $bad ), 'accepted', 'refused' );
	} catch ( LunaSpin_Error $e ) {
		$pass++;
	}
}

echo "php: {$pass} passed, {$fail} failed" . ( $has_nfc ? '' : ' (no intl: NFC cases skipped)' ) . "\n";
exit( $fail ? 1 : 0 );
