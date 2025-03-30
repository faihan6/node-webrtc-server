import { ServerContext } from "../../api/client_api.js";

const mediaSourceChoiceInput = document.getElementById('media-select');
const startButton = document.getElementById('start-media');
const localFeed = document.getElementById('local-feed');
const feedContainer = document.getElementById('feed-container');

localFeed.volume = 0.01

/**
 * each slot denotes two MIDs. One for audio and one for video.
 */
const subscribeInfo = {
    0: null, 1: null, 2: null, 3: null, 4: null
}

const server = new ServerContext();
const response = await server.connect();
console.log('Login response', response);

for(const userDetails of response.usersList){
    if(userDetails.userId == server.userId){
        continue;
    }
    if(userDetails.sendingAudio && userDetails.sendingVideo){
        subscribeToFreeSlot(userDetails.userId);
    }
}

function subscribeToFreeSlot(userId){
    console.log(subscribeInfo)
    const freeSlot = Object.keys(subscribeInfo).find(key => !subscribeInfo[key]);
    subscribeInfo[freeSlot] = userId;
    console.log('Subscribing to free slot', freeSlot, userId);
    server.subscribe(userId, freeSlot * 2, freeSlot * 2 + 1);
}

server.addEventListener('user-joined', (event) => {
    console.log('User joined', event.detail);

    const detail = event.detail.userDetails;
    if(detail.sendingAudio && detail.sendingVideo){
        subscribeToFreeSlot(detail.userId);
    }

    
})

server.addEventListener('user-left', (event) => {
    console.log('User left', event);
    const userId = event.detail.userId;
    const slot = Object.keys(subscribeInfo).find(key => subscribeInfo[key] == userId);
    subscribeInfo[slot] = null;
})

window.server = server;


const peer = new RTCPeerConnection();

await new Promise(res => {
    startButton.addEventListener('click', res);
})

const mediaSource = mediaSourceChoiceInput.value;

if(mediaSource == 'camera'){
    const stream = await navigator.mediaDevices.getUserMedia({video: true, audio: true});
    peer.addTrack(stream.getAudioTracks()[0], stream);
    peer.addTrack(stream.getVideoTracks()[0], stream);
    localFeed.srcObject = stream;
    await localFeed.play();
}
else if(mediaSource.includes('sample')){
    const path = mediaSource == 'sample1' ? 'tmp_html/Django Unchained Beer Scene_1.mp4' : 'tmp_html/IngloriousBasterdsCut.mp4';
    localFeed.src = `${location.origin}/${path}`;
    await localFeed.play();
    const stream = localFeed.captureStream();
    peer.addTrack(stream.getAudioTracks()[0], stream);
    peer.addTrack(stream.getVideoTracks()[0], stream);
}
else{
    peer.addTransceiver('audio', {direction: 'recvonly'});
    peer.addTransceiver('video', {direction: 'recvonly'});
}

for(let i = 0; i < 4; i++){
    peer.addTransceiver('audio', {direction: 'recvonly'});
    peer.addTransceiver('video', {direction: 'recvonly'});
}

const offer = await peer.createOffer();
await peer.setLocalDescription(offer);

await new Promise(res => {
    peer.onicegatheringstatechange = () => {
        if(peer.iceGatheringState == 'complete'){
            res();
        }
    }
})

const answer = await server.sendOffer(peer.localDescription);
await peer.setRemoteDescription(answer);

// let params = peer.getSenders()[0]?.getParameters();
// if(params){
//     params.encodings[0].maxBitrate = 5 * 1000;
//     peer.getSenders()[0].setParameters(params);
// }

// params = peer.getSenders()[1]?.getParameters();
// if(params){
//     params.encodings[0].maxBitrate = 10 * 1000;
//     peer.getSenders()[1].setParameters(params);
// }

console.log('peer signalling done!');

const streams = {};

for(const tx of peer.getTransceivers()){
    const mid = tx.mid;
    const participantNo = Math.floor(mid / 2);

    const track = tx.receiver.track;

    const stream = streams[participantNo] || new MediaStream();
    stream.addTrack(track);
    streams[participantNo] = stream;

}

for(const stream of Object.values(streams)){
    const video = document.createElement('video');
    feedContainer.appendChild(video);
    video.srcObject = stream;
    video.autoplay = true;
    video.playsInline = true;
    video.play();
}

// calculate overall outbound and inbound loss and bitrate every 3 seconds

let prevInboundLoss = 0;
let prevOutboundLoss = 0;
let prevInboundPackets = 0;
let prevOutboundPackets = 0;
let prevInboundBytes = 0;
let prevOutboundBytes = 0;

setInterval(async () => {
    const stats = await peer.getStats();
    
    // calculate packetloss percentage and bitrate

    let inboundLoss = 0;
    let outboundLoss = 0;
    let inboundPackets = 0;
    let outboundPackets = 0;
    let inboundBytes = 0;
    let outboundBytes = 0;

    for(const report of stats.values()){
        if(report.type == 'inbound-rtp'){
            inboundLoss += report.packetsLost;
            inboundPackets += report.packetsReceived;
            inboundBytes += report.bytesReceived;
        }
        else if(report.type == 'outbound-rtp'){
            outboundPackets += report.packetsSent;
            outboundBytes += report.bytesSent;
        }
        else if(report.type == 'remote-inbound-rtp'){
            outboundLoss += report.packetsLost;
        }
    }

    const inboundLossPercent = (inboundLoss - prevInboundLoss) * 100 / (inboundPackets - prevInboundPackets);
    const outboundLossPercent = (outboundLoss - prevOutboundLoss) * 100 / (outboundPackets - prevOutboundPackets);

    const inboundBitrate = (inboundBytes - prevInboundBytes) * 8 / 3000;
    const outboundBitrate = (outboundBytes - prevOutboundBytes) * 8 / 3000;

    console.log(`IN: Packets: ${inboundPackets}, Lost: ${inboundLoss} | OUT: Packets: ${outboundPackets}, Lost: ${outboundLoss}`);
    console.log(`IN: ${inboundLossPercent.toFixed(2)}% loss, ${inboundBitrate.toFixed(2)} kbps | OUT: ${outboundLossPercent.toFixed(2)}% loss, ${outboundBitrate.toFixed(2)} kbps`);

    prevInboundLoss = inboundLoss;
    prevOutboundLoss = outboundLoss;
    prevInboundPackets = inboundPackets;
    prevOutboundPackets = outboundPackets;



}, 3000)





