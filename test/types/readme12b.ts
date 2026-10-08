// The README's point and box example, compiled so it stays correct.
import { BoxAnswer, DecisionNode, Image, PointAnswer, box, point, truth } from '../../src/index.js';

declare const robot: { pick(x: number, y: number): void };
declare function sendToOperator(): void;

export async function readme12b() {
  const dn = new DecisionNode();

  const d = await dn.decide({
    images: [Image.fromUrl('belt', 'https://files.example.com/line-3/cam-2/0917.jpg')],
    questions: {
      pick: point('Point to the yellow package closest to the robot arm.'),
      damage: box('Draw a box around the damaged package.', 'belt'),
      any_damage: truth('Is any package on the belt damaged?'),
    },
  });

  const pick: PointAnswer = d.answers.pick; // a PointAnswer
  if (pick.present > 0.8 && pick.confidence > 0.7) {
    robot.pick(pick.x, pick.y);
  } else {
    sendToOperator();
  }
  const damage: BoxAnswer = d.answers.damage;
  return damage.x2 - damage.x1;
}
