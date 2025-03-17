
# Node WebRTC Server

  

This repository contains a WebRTC implementation written entirely in Node.js along with an implementation for a simple SFU server. A Web client API is also provided to allow WebApps to establish connections with the server.

**The following functionalities are implemented entirely in Node.js**

1. ICE/STUN
2. DTLS
3. SRTP
4. RTP
  

**Note: This project is still under development. As of now, this is an alpha-quality software, and might have bugs and security issues.**

  
  
  

## Table of Contents

- [Installation](#installation)

- [Usage](#usage)

- [Contributing](#contributing)

- [To-do](#to-do)

- [Examples](#examples)

- [License](#license)

  

## Installation

  

To install the application and the necessary dependencies for *nix (UNIX-like) systems, do the following.

  

1. Install dependencies

```bash

npm  install

```
2. Generate a certificate-key pair for DTLS handshakes. When prompted for details, you can choose to provide them or skip (press enter).

```bash
mkdir certificates;
cd certificates;
openssl ecparam -name prime256v1 -genkey -noout -out key.pem;
openssl req -new -key key.pem -out ecdsa.csr;
openssl req -x509 -key key.pem -days 365 -out cert.pem;
cd ..
```
3. You need a `server-config.toml` file which contains configurations for the server. A sample file is already provided with the name `server-config.example.toml`. Copy it and save it with `server-config.toml` as the name and make changes as required.
  

## Usage

  

To start the application, run the following command

```bash

npm  start

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

**DTLS**

 1. Verify certificates in handshake with fingerprint provided in SDP.
 2. Verify client finished
 3. Handle out-of-order, missing DTLS packets
 4. Implement missing mandatory cipher suites

**RTP**

1. Serve NACKs from receivers by buffering packets locally.
2. Send RTCP Sender Reports to receivers

**Codecs**

1. VP8 - handle temporal scalability
2. VP9 - handle temporal and spacial scalability
3. Support for AV1

**Congestion control**

1. Implement TWCC
2. Dynamically adjust outgoing bitrate to receiver during congestion by adjusting temporal/spatial layers.


## License

  

This project is licensed under the BSD-3-Clause license. See the [LICENSE](LICENSE.txt) file for details.