const String kAppVersion = '0.1.0';
const String kUserAgent = 'denia-mobile/$kAppVersion';

/// Pairing links are the only server-authored format the client parses, and
/// only to extract v2 fields. Redemption always sends the whole link back.
const String kPairingScheme = 'denia';
const String kPairingHost = 'connect';
