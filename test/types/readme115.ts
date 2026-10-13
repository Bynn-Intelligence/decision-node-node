// The README's Collections example, compiled so it stays correct.
import { DecisionNode, DecisionNodeError, Image, type CollectionItemPage } from '../../src/index.js';

export async function readme115() {
  const dn = new DecisionNode();

  const staff = await dn.collections.create({ name: 'Staff' });
  const item = await dn.collections.enroll(staff.id, {
    image: Image.fromUrl('badge', 'https://files.example.com/badges/emp-1042.jpg'),
    reference: 'emp-1042',
    label: 'Reception',
    metadata: { department: 'Reception', badge_level: 2, visitor: false },
  });

  await dn.collections.updateItem(staff.id, item.id, { label: null, metadata: { department: 'Front desk' } });
  const page: CollectionItemPage = await dn.collections.listItems(staff.id, { reference_prefix: 'emp-' });
  const capped: boolean | undefined = page.total_capped;

  try {
    await dn.collections.enroll(staff.id, { image: Image.fromUrl('b', 'https://files.example.com/b.jpg'), reference: 'emp-1043' });
  } catch (err) {
    if (err instanceof DecisionNodeError) {
      const why: unknown = err.details?.reason;
      void why;
    }
  }
  void capped;
}
