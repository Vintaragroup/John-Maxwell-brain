import axios from 'axios';
import { config } from './config';

export type AudioFormat = 'mp3' | 'wav' | 'flac' | 'ogg';

const OUTPUT_FORMAT_BY_TYPE: Record<AudioFormat, string> = {
  mp3: 'mp3_44100_128',
  wav: 'pcm_44100',
  flac: 'pcm_44100', // ElevenLabs has no native flac output; caller gets PCM under a flac request
  ogg: 'mp3_44100_128' // ElevenLabs has no native ogg output; caller gets mp3 under an ogg request
};

export async function synthesizeSpeech(text: string, format: AudioFormat = 'mp3', parametersOverride?: Record<string, any>): Promise<Buffer> {
  const { apiKey, voiceId, modelId } = config.voice.elevenlabs;
  if (!apiKey || !voiceId) throw new Error('ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID missing');

  const outputFormat = OUTPUT_FORMAT_BY_TYPE[format] || OUTPUT_FORMAT_BY_TYPE.mp3;
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(outputFormat)}`;

  const res = await axios.post(url, {
    text,
    model_id: modelId,
    voice_settings: parametersOverride
  }, {
    responseType: 'arraybuffer',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg'
    },
    timeout: 60000
  });
  return Buffer.from(res.data);
}
