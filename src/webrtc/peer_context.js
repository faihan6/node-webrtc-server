const { SRTPContext } = require('./srtp');

const { DTLSContext, getFingerprintOfCertificate } = require('./dtls');
const { ICEContext } = require('./stun');
const { SimpleStream } = require('../helpers/simple_stream');
class PeerContext{

    remoteCertificateFingerprint = null;

    iceContext = new ICEContext({onPacketReceived: this.allocatePacketToAppropriateMethod.bind(this)});
    #srtpContext = new SRTPContext({
        onPacketReadyToSend: this.iceContext.sendPacket.bind(this.iceContext),
        onRTPPacketReadyForApplication: this.#processPacket.bind(this)
    });
    dtlsContext = new DTLSContext({onDTLSParamsReady: this.#srtpContext.initSRTP.bind(this.#srtpContext)});

    // TODO: direction is a property of transceiver, not peer itself. need to change it.
    selfDirection = null;
    remoteDirection = null;

    rtpStreamSubscriberCallbacks = {};

    #remoteSSRCStreams = {
        null: {
            rtp: new SimpleStream(),
            rtcpEvents: new SimpleStream()
        }
    };
    #localSSRCStreams = {};


    constructor(){
    }

    async generateAnswer(offer) {

        /*
            TODO
                1. extract all the candidates from the offer
                2. Get ICE ufrag and pwd from the offer
                3. Get the certificate fingerprint from the offer
    
                4. Generate ICE ufrag and pwd for self
                5. Generate new certificate for self. Generate its fingerprint
    
                6. Generate answer
                    - add the self candidate
                    - add the self ufrag and pwd
                    - add the self certificate fingerprint
        */
    
        // 1. extract all the candidates from the offer
        const remoteCandidates = [];
        offer.sdp.split('\r\n').forEach(line => {
            if (line.startsWith('a=candidate')) {
                remoteCandidates.push(line);
            }
        });
    
        // 2. Get ICE ufrag and pwd from the offer
        const remoteUfrag = offer.sdp.match(/a=ice-ufrag:(.*)/)[1];
        const remotePwd = offer.sdp.match(/a=ice-pwd:(.*)/)[1];
        this.iceContext.setRemoteUfragAndPassword(remoteUfrag, remotePwd);
    
        // 3. Get the certificate fingerprint from the offer
        const remoteCertificateFingerprint = offer.sdp.match(/a=fingerprint:(.*)/)[1];
        this.dtlsContext.setRemoteFingerprint(remoteCertificateFingerprint);
    
        // 4. get ICE ufrag and pwd for self
        const selfUfrag = this.iceContext.selfUfrag
        const selfPwd = this.iceContext.selfPwd

        const remoteDirection = offer.sdp.match(/a=sendrecv|a=recvonly|a=sendonly|a=inactive/)[0];
        const selfDirection = (remoteDirection == 'a=sendonly') ? 'a=recvonly' : 
                                (remoteDirection == 'a=recvonly') ? 'a=sendonly' : 
                                remoteDirection;

        this.selfDirection = selfDirection;
        this.remoteDirection = remoteDirection;
    
        // console.log('candidates', remoteCandidates);
        // console.log('ufrag', remoteUfrag);
        // console.log('pwd', remotePwd);
        // console.log('fingerprint', remoteCertificateFingerprint);
        // console.log('self_ufrag', selfUfrag);
        // console.log('self_pwd', selfPwd);
    
        let sdp = '';
        sdp += 'v=0\r\n';
        sdp += 'o=- 0 0 IN IP4 127.0.0.1\r\n';
        sdp += 's=-\r\n';
        sdp += 't=0 0\r\n';
        //answer += 'a=group:BUNDLE 0\r\n';
        sdp += 'a=msid-semantic:WMS *\r\n';
        sdp += 'm=video 9 UDP/TLS/RTP/SAVP 96\r\n';
        sdp += 'a=mid:0\r\n'
        sdp += 'c=IN IP4 0.0.0.0\r\n';
        sdp += 'a=rtcp:9 IN IP4 0.0.0.0\r\n';
        sdp += 'a=ice-ufrag:' + selfUfrag + '\r\n';
        sdp += 'a=ice-pwd:' + selfPwd + '\r\n';
    
        const fp = this.formatFingerprint(await getFingerprintOfCertificate())
        console.log('our fingerprint', fp);
        sdp +=  (fp) + '\r\n';
        sdp += 'a=setup:passive\r\n';
        
        for(const candidateStr of this.iceContext.getCandidates()){
            sdp += candidateStr;
        }

        sdp += `${selfDirection}\r\n`;
        sdp += 'a=rtcp-mux\r\n';
        sdp += 'a=rtcp-rsize\r\n';
        sdp += 'a=rtpmap:96 VP8/90000\r\n';
        // answer += 'a=rtcp-fb:96 goog-remb\r\n';
        // answer += 'a=rtcp-fb:96 transport-cc\r\n';
        // answer += 'a=rtcp-fb:96 ccm fir\r\n';
        // answer += 'a=rtcp-fb:96 nack\r\n';
        // answer += 'a=rtcp-fb:96 nack pli\r\n';
    
        //console.log('\n\nanswer:\n', sdp); 
    
        return sdp;
    
    
    
    
    }

    formatFingerprint(hash) {
        // Format the hash as specified
        const formattedFingerprint = hash.match(/.{2}/g).join(':');
        return `a=fingerprint:sha-256 ${formattedFingerprint}`;
    }

    allocatePacketToAppropriateMethod(packet, remote){
        if(packet.at(0) == 0x16){
            const response = this.dtlsContext.handleDTLS(packet);
            this.iceContext.sendPacket(response, remote);
        }
        if(packet.at(0) >> 6 == 0x02){
            this.#srtpContext.handlePacketFromRemote(packet, remote);
        }
    }

    #processPacket(packet){
        const payloadType = packet.readUInt8(1) & 0b01111111;

        if(payloadType == 96){
            this.#handleRTPPacket(packet);
        }
        else{
            this.#handleRTCPPacket(packet)
            
        }
       
    }

    #handleRTPPacket(packet){
        const ssrc = packet.readUInt32BE(8);
        this.#initStreams(ssrc);

        //console.log('RTP SSRC:', ssrc);
        this.#remoteSSRCStreams[null].rtp.write(packet);
        this.#remoteSSRCStreams[ssrc].rtp.write(packet);
    }

    #handleRTCPPacket(packet){
        const lengthInBytes = (packet.readUInt16BE(2) + 1) * 4;
        //console.log(`\nRTCP packet arrived. length specified in packet: ${lengthInBytes}, bufferLength: ${packet.length}`);
        //console.log('RTCP packet:', packet);
        if(packet.length == lengthInBytes){
            this.#handleSingleRTCPPacket(packet);
        }
        else{
            let startIndex = 0;
            while(true){
                console.log('startIndex:', startIndex);
                const rtpPacketLengthBytes = (packet.readUInt16BE(startIndex + 2) * 4) + 1;
                const rtpPacketBuffer = packet.slice(startIndex, startIndex + rtpPacketLengthBytes);

                this.#handleSingleRTCPPacket(rtpPacketBuffer);

                startIndex += rtpPacketLengthBytes;
                if(startIndex == packet.length){
                    break;
                }
            }
        }
    }

    #handleSingleRTCPPacket(packet){
        let ssrc;

        const payloadType = packet.readUInt8(1) & 0b01111111;
        if(payloadType == 201){
            ssrc = packet.readUInt32BE(8);
        }
        else{
            ssrc = packet.readUInt32BE(4);
        }

        this.#initStreams(ssrc);

        console.log('RTCP SSRC:', ssrc);
        this.#remoteSSRCStreams[null].rtcpEvents.write(packet);
        this.#remoteSSRCStreams[ssrc].rtcpEvents.write(packet);
    }

    #initStreams(ssrc){
        if(!this.#remoteSSRCStreams[ssrc]){
            this.#remoteSSRCStreams[ssrc] = {
                rtp: new SimpleStream(),
                rtcpEvents: new SimpleStream()
            };
        }
    }

    subscribeToRTPStream(ssrc){
        console.log('Subscribing to RTP stream with ssrc', ssrc);
        this.#initStreams(ssrc);
        return this.#remoteSSRCStreams[ssrc].rtp;
    }

    subscribeToRTCPEventsStream(ssrc){
        console.log('Subscribing to RTCP Events stream with ssrc', ssrc);
        this.#initStreams(ssrc);
        return this.#remoteSSRCStreams[ssrc].rtcpEvents;
    }

    addRTPStream(stream){
        console.log('Adding RTP stream to peer context', stream);
        stream.addEventListener('data', (data) => {
            //console.log('RTP from remote arrived, writing to wire..')
            this.#srtpContext.sendPacketToRemote(data);
        })
    }

    addRTCPEventsStream(stream){
        console.log('Adding RTCP Events stream to peer context', stream);
        stream.addEventListener('data', (data) => {
            console.log('RTCP arrived, writing to wire..')
            this.#srtpContext.sendPacketToRemote(data);
        })
    }

}

module.exports = {
    PeerContext
}