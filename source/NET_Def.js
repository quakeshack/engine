
// This is the network info/connection protocol.  It is used to find Quake
// servers, get info about them, and connect to them.  Once connected, the
// Quake game protocol (documented elsewhere) is used.
//
//
// General notes:
//	game_name is currently always "QUAKE", but is there so this same protocol
//		can be used for future games as well; can you say Quake2?
//
// CCREQ_CONNECT
//		string	game_name				"QUAKE"
//		byte	net_protocol_version	NET_PROTOCOL_VERSION
//
// CCREQ_SERVER_INFO
//		string	game_name				"QUAKE"
//		byte	net_protocol_version	NET_PROTOCOL_VERSION
//
// CCREQ_PLAYER_INFO
//		byte	player_number
//
// CCREQ_RULE_INFO
//		string	rule
//
//
//
// CCREP_ACCEPT
//		long	port
//
// CCREP_REJECT
//		string	reason
//
// CCREP_SERVER_INFO
//		string	server_address
//		string	host_name
//		string	level_name
//		byte	current_players
//		byte	max_players
//		byte	protocol_version	NET_PROTOCOL_VERSION
//
// CCREP_PLAYER_INFO
//		byte	player_number
//		string	name
//		long	colors
//		long	frags
//		long	connect_time
//		string	address
//
// CCREP_RULE_INFO
//		string	rule
//		string	value

//	note:
//		There are two address forms used above.  The short form is just a
//		port number.  The address that goes along with the port is defined as
//		"whatever address you receive this reponse from".  This lets us use
//		the host OS to solve the problem of multiple host addresses (possibly
//		with no routing between them); the host will use the right address
//		when we reply to the inbound connection request.  The long from is
//		a full address and port in a string.  It is used for returning the
//		address of a server that is not running locally.

// Network Header Flags
const NetFlags = {
  LENGTH_MASK: 0x0000ffff,
  DATA: 0x00010000,
  ACK: 0x00020000,
  NAK: 0x00040000,
  EOM: 0x00080000,
  UNRELIABLE: 0x00100000,
  CTL: 0x80000000,
};

// Protocol Version
const NetProtocol = {
  VERSION: 3,
  GAME_NAME: "QUAKE",
};

// Connection Control Requests
const CCRequest = {
  CONNECT: 0x01,
  SERVER_INFO: 0x02,
  PLAYER_INFO: 0x03,
  RULE_INFO: 0x04,
};

// Connection Control Replies
const CCReply = {
  ACCEPT: 0x81,
  REJECT: 0x82,
  SERVER_INFO: 0x83,
  PLAYER_INFO: 0x84,
  RULE_INFO: 0x85,
};

// Exporting the constants if using a module system
module.exports = { NetFlags, NetProtocol, CCRequest, CCReply };
