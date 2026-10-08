// The README's video example, compiled so it stays correct.
import { DecisionNode, Video, VideoFrame, number, truth } from '../../src/index.js';

declare const cameraFrames: Array<[number, Uint8Array]>;

export async function readme12() {
  const dn = new DecisionNode();

  // cameraFrames: [seconds, JPEG bytes] pairs you already hold
  const frames = cameraFrames.map(([t, jpeg]) => new VideoFrame(t, jpeg));

  const d = await dn.decide({
    state: 'Warehouse camera 4, loading dock, shift B.',
    videos: [new Video('dock', frames, { fps: 2 })],
    questions: {
      fall: truth('Does a person fall in the video?'),
      forklifts: number('How many forklifts pass the door?', 0, 50),
    },
  });

  const fall: number = d.answers.fall.truth;
  const read: number | null = d.usage.videoFrames;
  const warnings: string[] = d.warnings;
  return { fall, read, warnings };
}
