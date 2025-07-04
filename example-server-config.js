
const config = {

    // Certificate and Key must be provided here. We will not generate them.
    certificatePath: "certificates/cert.pem",
    keyPath: "certificates/key.pem",

    // Specify the audio codecs that will be supported.
    audioSupportedCodecs: ["opus/48000"],

    // Specify the video codecs that will be supported.
    videoSupportedCodecs: ["VP8/90000"],

    // Specify the header extensions that will be supported.
    supportedHeaderExtensions: [
        'urn:ietf:params:rtp-hdrext:sdes:mid'
    ],

    // Specify the IP address that will be used as the IP address in SRFLX candidates.
    //publicIP: "0.0.0.0",

    // Specify the time (in milliseconds) to wait before sending NACKs.
    nackWaitTimeMS: 0,

    // Specify the path to the file where DTLS secrets are logged.
    // keyLogOutputPath: "keylog.log",

    // Disable DTLS encryption. ENABLE ONLY FOR DEBUGGING PURPOSES.
    disableWebRTCEncryption: false,

    // Output DTLS keys to the console.
    outputDTLSSecrets: false,
    keyLogOutputPath: "keylog.log",

    // Disable WebSocket Secure mode. ENABLE ONLY FOR DEBUGGING PURPOSES.
    disableWebSocketSecure: false,
    //websocketServerCertificatePath: "path/to/your/certificate.pem",
    //websocketServerKeyPath: "path/to/your/private-key.pem",


}


module.exports = config;

