// The README's several-places example, compiled so it stays correct.
import { BoxesAnswer, DecisionNode, Image, PointsAnswer, box, point } from '../../src/index.js';

declare function draw(x1: number, y1: number, x2: number, y2: number, confidence: number): void;
declare function askAgainWithMore(): void;

export async function readme112() {
  const dn = new DecisionNode();

  const d = await dn.decide({
    images: [Image.fromUrl('lot', 'https://files.example.com/lot/0917.jpg')],
    questions: {
      cars: box('Every car in the lot.', 'lot', null, 8),
      people: point('Each person standing on the platform.', 'lot', null, 6),
    },
  });

  const cars: BoxesAnswer = d.answers.cars; // a BoxesAnswer
  for (const car of cars.boxes) draw(car.x1, car.y1, car.x2, car.y2, car.confidence);
  if (cars.complete < 0.5) askAgainWithMore();
  const people: PointsAnswer = d.answers.people;
  return people.points.map((p) => [p.x, p.y, p.confidence]);
}
