<?php
/**
 * LunaSpin core rules (scheme "lunaspin:v1"), the PHP twin of src/core.js.
 *
 * Used by the Lunardraw theme's server side. Must give exactly the same
 * answers as the JS rules: both are tested against test/vectors.json.
 * Plain PHP 8 with the hash extension; Normalizer (intl) and mbstring are
 * used when present. Whole numbers for picking must stay below 2^53.
 *
 * @package lunardraw
 */

if ( defined( 'LUNASPIN_SCHEME' ) ) {
	return;
}

const LUNASPIN_SCHEME             = 'lunaspin:v1';
const LUNASPIN_TAG                = 'lunaspin|v1';
const LUNASPIN_CERTIFICATE_FORMAT = 'lunaspin-certificate/1';
const LUNASPIN_MIN_ENTRIES        = 2;
const LUNASPIN_MAX_ENTRIES        = 10000;
const LUNASPIN_MAX_NAME           = 80;
const LUNASPIN_MAX_TITLE          = 120;
const LUNASPIN_MAX_WINNERS        = 100;
const LUNASPIN_MAX_TEAMS          = 50;
const LUNASPIN_SPACE              = '\t\n\x{0B}\f\r \x{85}\x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}';

/** A rule was broken; `code` matches the JS error codes. */
class LunaSpin_Error extends Exception {
	/** @var string */
	public $lunaspin_code;
	public function __construct( string $code, string $message ) {
		parent::__construct( $message );
		$this->lunaspin_code = $code;
	}
}

/** Compact's pad(32, s): the UTF-8 bytes, then zeros to 32 bytes. */
function lunaspin_pad32( string $s ): string {
	if ( strlen( $s ) > 32 ) {
		throw new LunaSpin_Error( 'bad_domain', 'domain longer than 32 bytes' );
	}
	return str_pad( $s, 32, "\0" );
}

function lunaspin_from_hex( $h, int $len ): string {
	$s = preg_replace( '/^0x/i', '', trim( (string) $h ) );
	if ( ! preg_match( '/^(?:[0-9a-fA-F]{2})*$/', $s ) || strlen( $s ) !== 2 * $len ) {
		throw new LunaSpin_Error( 'bad_hex', "expected {$len} bytes of hex" );
	}
	return hex2bin( $s );
}

/** One name, tidied: Unicode NFC, trimmed, inner spaces collapsed to one. */
function lunaspin_tidy( $s ): string {
	$s = (string) $s;
	if ( ! preg_match( '//u', $s ) ) {
		throw new LunaSpin_Error( 'bad_entry', 'not valid UTF-8' );
	}
	if ( class_exists( 'Normalizer' ) ) {
		$n = Normalizer::normalize( $s, Normalizer::FORM_C );
		if ( false !== $n ) {
			$s = $n;
		}
	}
	$sp = LUNASPIN_SPACE;
	$s  = preg_replace( "/^[{$sp}]+|[{$sp}]+$/u", '', $s );
	return preg_replace( "/[{$sp}]+/u", ' ', $s );
}

/** Characters as people count them (code points). */
function lunaspin_length( string $s ): int {
	return function_exists( 'mb_strlen' ) ? mb_strlen( $s, 'UTF-8' ) : (int) preg_match_all( '/./us', $s );
}

/** Whether names arrive already tidied. Without Normalizer, NFC can't be checked here (the browser does it). */
function lunaspin_check_entries( $names ): array {
	if ( ! is_array( $names ) || array_values( $names ) !== $names ) {
		throw new LunaSpin_Error( 'bad_entries', 'entries must be a list' );
	}
	$n = count( $names );
	if ( $n < LUNASPIN_MIN_ENTRIES ) {
		throw new LunaSpin_Error( 'too_few', 'at least ' . LUNASPIN_MIN_ENTRIES . ' entries' );
	}
	if ( $n > LUNASPIN_MAX_ENTRIES ) {
		throw new LunaSpin_Error( 'too_many', 'at most 10,000 entries' );
	}
	foreach ( $names as $i => $name ) {
		if ( ! is_string( $name ) || '' === $name || lunaspin_tidy( $name ) !== $name ) {
			throw new LunaSpin_Error( 'bad_entry', 'entry ' . ( $i + 1 ) . " isn't tidied" );
		}
		if ( lunaspin_length( $name ) > LUNASPIN_MAX_NAME ) {
			throw new LunaSpin_Error( 'entry_too_long', 'entry ' . ( $i + 1 ) . ' is over ' . LUNASPIN_MAX_NAME . ' characters' );
		}
	}
	return $names;
}

/** Nightcast's listCommitment: SHA-256 of "nightcast:list:v1", the count, then each item's length and bytes (4-byte big-endian lengths). */
function lunaspin_list_commitment( array $items ): string {
	$ctx = hash_init( 'sha256' );
	hash_update( $ctx, 'nightcast:list:v1' . pack( 'N', count( $items ) ) );
	foreach ( $items as $item ) {
		if ( ! is_string( $item ) ) {
			throw new LunaSpin_Error( 'bad_entry', 'listCommitment takes strings' );
		}
		hash_update( $ctx, pack( 'N', strlen( $item ) ) . $item );
	}
	return hash_final( $ctx );
}

function lunaspin_check_rules( $rules ): array {
	$rules = (array) $rules;
	$mode  = $rules['mode'] ?? null;
	$list  = $rules['list'] ?? 'public';
	$title = lunaspin_tidy( $rules['title'] ?? '' );
	if ( ! in_array( $mode, array( 'pick', 'pick-many', 'shuffle', 'teams' ), true ) ) {
		throw new LunaSpin_Error( 'bad_mode', 'mode must be one of pick, pick-many, shuffle, teams' );
	}
	if ( ! in_array( $list, array( 'public', 'private' ), true ) ) {
		throw new LunaSpin_Error( 'bad_list', 'list must be public or private' );
	}
	if ( 'private' === $list && 'shuffle' === $mode ) {
		throw new LunaSpin_Error( 'private_shuffle', 'a private list can only use pick modes: a shuffle reveals every name' );
	}
	if ( 'private' === $list && 'teams' === $mode ) {
		throw new LunaSpin_Error( 'private_teams', 'a private list can only use pick modes: teams reveal every name' );
	}
	if ( lunaspin_length( $title ) > LUNASPIN_MAX_TITLE ) {
		throw new LunaSpin_Error( 'title_too_long', 'the title is over ' . LUNASPIN_MAX_TITLE . ' characters' );
	}
	$r = array( 'mode' => $mode, 'list' => $list, 'title' => $title );
	if ( 'pick-many' === $mode ) {
		$c = $rules['count'] ?? null;
		if ( ! is_int( $c ) || $c < 2 || $c > LUNASPIN_MAX_WINNERS ) {
			throw new LunaSpin_Error( 'bad_count', 'winners must be 2 to ' . LUNASPIN_MAX_WINNERS );
		}
		$r['count'] = $c;
	}
	if ( 'teams' === $mode ) {
		$t = $rules['teams'] ?? null;
		if ( ! is_int( $t ) || $t < 2 || $t > LUNASPIN_MAX_TEAMS ) {
			throw new LunaSpin_Error( 'bad_teams', 'teams must be 2 to ' . LUNASPIN_MAX_TEAMS );
		}
		$r['teams'] = $t;
	}
	return $r;
}

/** The rules as text, in a fixed order. */
function lunaspin_rules_list( $rules ): array {
	$r   = lunaspin_check_rules( $rules );
	$out = array( 'lunaspin:rules:v1', 'mode=' . $r['mode'] );
	if ( 'pick-many' === $r['mode'] ) {
		$out[] = 'count=' . $r['count'];
	}
	if ( 'teams' === $r['mode'] ) {
		$out[] = 'teams=' . $r['teams'];
	}
	$out[] = 'list=' . $r['list'];
	$out[] = 'title=' . $r['title'];
	return $out;
}

function lunaspin_rules_commitment( $rules ): string {
	return lunaspin_list_commitment( lunaspin_rules_list( $rules ) );
}

/** A private list's entry hash: SHA-256 of pad32("lunaspin:entry:v1"), the 16-byte salt, the name's length and bytes. */
function lunaspin_entry_hash( string $salt_hex, string $name ): string {
	return hash( 'sha256', lunaspin_pad32( 'lunaspin:entry:v1' ) . lunaspin_from_hex( $salt_hex, 16 ) . pack( 'N', strlen( $name ) ) . $name );
}

function lunaspin_list_items( array $names, string $list, $entry_salts = null ): array {
	if ( 'private' !== $list ) {
		return $names;
	}
	if ( ! is_array( $entry_salts ) || count( $entry_salts ) !== count( $names ) ) {
		throw new LunaSpin_Error( 'bad_salts', 'one salt per entry' );
	}
	$out = array();
	foreach ( array_values( $names ) as $i => $name ) {
		$out[] = lunaspin_entry_hash( (string) $entry_salts[ $i ], $name );
	}
	return $out;
}

/** The 32-byte Nightcast seed: SHA-256 of pad32("lunaspin:v1"), list fingerprint, rules fingerprint, salt. */
function lunaspin_spin_seed( string $list_fp, string $rules_fp, string $salt_hex ): string {
	return hash( 'sha256', lunaspin_pad32( LUNASPIN_SCHEME ) . lunaspin_from_hex( $list_fp, 32 ) . lunaspin_from_hex( $rules_fp, 32 ) . lunaspin_from_hex( $salt_hex, 32 ) );
}

/** Everything that goes into a spin's seed. Keys: names, rules, salt, entrySalts (private lists). */
function lunaspin_lock_spin( array $spin ): array {
	$names = lunaspin_check_entries( $spin['names'] ?? null );
	$r     = lunaspin_check_rules( $spin['rules'] ?? array() );
	if ( 'teams' === $r['mode'] && $r['teams'] > count( $names ) ) {
		throw new LunaSpin_Error( 'bad_teams', 'more teams than entries' );
	}
	$items = lunaspin_list_items( $names, $r['list'], $spin['entrySalts'] ?? null );
	$lfp   = lunaspin_list_commitment( $items );
	$rfp   = lunaspin_rules_commitment( $r );
	return array(
		'rules'   => $r,
		'items'   => $items,
		'listFp'  => $lfp,
		'rulesFp' => $rfp,
		'seed'    => lunaspin_spin_seed( $lfp, $rfp, (string) ( $spin['salt'] ?? '' ) ),
	);
}

/** The contract's randomWord(output, i): SHA-256 of pad32("nightcast:word:v0"), the output, i (4-byte little-endian). Raw bytes. */
function lunaspin_random_word( string $output_bin, int $i ): string {
	return hash( 'sha256', lunaspin_pad32( 'nightcast:word:v0' ) . $output_bin . pack( 'V', $i ), true );
}

/**
 * @nightcast/sdk uniformInt for n below 2^53: a whole number in [0, n) from a
 * 32-byte word, rejecting words at or above 2^256 − (2^256 mod n) and
 * rehashing with ":1", ":2", … exactly as the SDK does.
 */
function lunaspin_uniform_int( string $word, int $n ): int {
	if ( $n < 1 || $n > 9007199254740991 ) {
		throw new LunaSpin_Error( 'bad_range', 'n must be 1 to 2^53 - 1' );
	}
	if ( 1 === $n ) {
		return 0;
	}
	$r = 1;
	for ( $k = 0; $k < 256; $k++ ) {
		$r = ( $r * 2 ) % $n;
	}
	for ( $i = 0; ; $i++ ) {
		$block = 0 === $i ? $word : hash( 'sha256', $word . ':' . $i, true );
		if ( lunaspin_below_limit( $block, $r ) ) {
			$m = 0;
			for ( $b = 0; $b < 32; $b++ ) {
				$m = ( $m * 256 + ord( $block[ $b ] ) ) % $n;
			}
			return $m;
		}
	}
}

/** Whether a 32-byte big-endian v is below 2^256 − r (r < 2^53): true unless the complement of v is below r. */
function lunaspin_below_limit( string $block, int $r ): bool {
	if ( 0 === $r ) {
		return true;
	}
	$c = ~$block;
	if ( ltrim( substr( $c, 0, 24 ), "\0" ) !== '' ) {
		return true;
	}
	if ( ord( $c[24] ) & 0x80 ) {
		return true;
	}
	$low = unpack( 'J', substr( $c, 24, 8 ) )[1];
	return $low >= $r;
}

/** @nightcast/sdk pickMany on positions 0…n−1. */
function lunaspin_pick_many_indexes( string $output_hex, int $n, int $count ): array {
	$out = lunaspin_from_hex( $output_hex, 32 );
	$a   = range( 0, $n - 1 );
	for ( $i = 0; $i < $count; $i++ ) {
		$j       = $i + lunaspin_uniform_int( lunaspin_random_word( $out, $i ), $n - $i );
		$t       = $a[ $i ];
		$a[ $i ] = $a[ $j ];
		$a[ $j ] = $t;
	}
	return array_slice( $a, 0, $count );
}

/** The result of a spin: 0-based positions, in order (as src/core.js resultIndexes). */
function lunaspin_result_indexes( string $output_hex, $rules, int $n ): array {
	$r = lunaspin_check_rules( $rules );
	if ( 'pick' === $r['mode'] ) {
		return array( lunaspin_uniform_int( lunaspin_random_word( lunaspin_from_hex( $output_hex, 32 ), 0 ), $n ) );
	}
	if ( 'pick-many' === $r['mode'] ) {
		if ( $r['count'] > $n ) {
			throw new LunaSpin_Error( 'bad_count', 'more winners than entries' );
		}
		return lunaspin_pick_many_indexes( $output_hex, $n, $r['count'] );
	}
	if ( 'teams' === $r['mode'] && $r['teams'] > $n ) {
		throw new LunaSpin_Error( 'bad_teams', 'more teams than entries' );
	}
	return lunaspin_pick_many_indexes( $output_hex, $n, $n );
}

/** Teams from a shuffled order, dealt round-robin (as src/core.js teamsOf). */
function lunaspin_teams_of( array $order, int $teams ): array {
	if ( $teams < 1 ) {
		throw new LunaSpin_Error( 'bad_teams', 'teams must be a whole number' );
	}
	$out = array_fill( 0, $teams, array() );
	foreach ( array_values( $order ) as $i => $idx ) {
		$out[ $i % $teams ][] = $idx;
	}
	return $out;
}

function lunaspin_new_salt(): string {
	return bin2hex( random_bytes( 32 ) );
}
