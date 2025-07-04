
# Node WebRTC Server

  

This repository contains a WebRTC implementation written entirely in JavaScript for Node.js runtime along with an implementation for a simple SFU server. A Web client API is also provided to allow WebApps to establish connections with the server.

**The following functionalities are implemented entirely in JavaScript for Node.js runtime**

1. ICE/STUN
2. DTLS
3. SRTP
4. RTP
  

**Note: This project is still under development. As of now, this is an alpha-quality software, and might have bugs and security issues.**

  
  
  

## Table of Contents

- [Features](#features)

- [Installation](#installation)

- [Usage](#usage)

- [Contributing](#contributing)

- [To-do](#to-do)

- [Examples](#examples)

- [License](#license)


## Features

  Some of the features provided are given below
  
  1. Multistreaming
  2. Audio-Video synchronization
  3. API Interface designed to be as close as possible to W3C WebRTC API, making it easy to write server applications on top of this software.
  4. No encryption mode for easier debugging.

## Installation

To install the application and the necessary dependencies for *nix (UNIX-like) systems, do the following.

  

1. Install dependencies

```bash

npm install

```
This will create a new config file (with default config options) and generate a certificate-key pair inside `certificates` directory for DTLS handshake.
  

## Usage

  

To start the application, run the following command

```bash

npm start

```
## Examples

To see this project in action,

1. Start a HTTP server in the directory `src/client`
2. Access `examples/sample_conference/sample_conference.html` file from a Web browser.
3. Choose `Camera/Mic` as source, and click `start` button.
4. Join from different tabs/browsers and do the same. You are now in a video conferencing setup.


## Contributing

  

Contributions are welcome! Please open an issue or submit a pull request.


## To-do

Following functionalities are not implemented yet/partially implemented. Contributions implementing these functionalities are very welcome!

**ICE**
1. ICE Password verification
2. Public IP candidates
3. ICE-restarts
4. Trickle ICE
5. IPv6 support.

**DTLS**

 1. Verify certificates in handshake with fingerprint provided in SDP.
 2. Verify client finished.
 3. Handle out-of-order, missing DTLS packets.
 4. Implement missing mandatory cipher suites.

**RTP**

1. Serve NACKs from receivers by buffering packets locally.
2. Send RTCP Sender Reports to receivers.

**Codecs**

1. VP8 - handle temporal scalability.
2. VP9 - handle temporal and spacial scalability.
3. Support for AV1.
4. Support Simulcast

**Congestion control**

1. Implement TWCC.
2. Dynamically adjust outgoing bitrate to receiver during congestion by adjusting temporal/spatial layers.

**Others**

1. Unit/Integration tests
2. Multithreading (Workers) support.
3. RTP dumping for debugging.
4. Conference support. (Ability to run multiple conferences inside a single server application instance)


## License

  

This project is licensed under the BSD-3-Clause license. See the [LICENSE](LICENSE.txt) file for details.