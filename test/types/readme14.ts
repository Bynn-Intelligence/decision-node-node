// The README's knowledge examples, compiled so they stay correct.
import {
  DecisionNode,
  Document,
  KnowledgeReading,
  knowledge,
  truth,
  type Collection,
  type CollectionItem,
  type KnowledgePassage,
} from '../../src/index.js';

export async function readme14() {
  const dn = new DecisionNode();

  const kb = await dn.collections.create({ name: 'Claims policy', type: 'text', scopeKey: 'mission' });

  await dn.collections.addDocument(kb.id, {
    document: '# Receipts\n\nReject any claim over 500 SEK without a receipt.',
    title: 'Receipts rule',
    reference: 'receipts-rule',
    pinned: true,
  });

  const policy = await dn.collections.addDocument(kb.id, {
    document: Document.fromPath('./claims-policy-2026.pdf'),
    reference: 'policy-2026',
  });

  const ready = await dn.collections.waitUntilReady(kb.id, { itemId: policy.id });
  if (ready.status === 'failed') console.error(ready.error);

  await dn.collections.addDocument(kb.id, {
    document: '# Special instructions\n\nPhotos of damage taken after 2026-09-01 count as current.',
    title: 'Mission M-42 brief',
    metadata: { mission: 'M-42' },
  });

  const d = await dn.decide({
    state: { claim: { amount: '740.00', receipt: false }, mission: 'M-42' },
    boosters: [knowledge(kb.id, { scope: 'M-42', require: true })],
    questions: { approve: truth('Should the claim be approved under our policy?') },
  });

  const reading = d.evidence?.knowledge?.results[0];
  if (reading instanceof KnowledgeReading) {
    for (const p of reading.passages) {
      console.log(p.n, p.pinned, p.title, p.heading, p.score);
    }
    const p: KnowledgePassage = reading.passages[0]!;
    const doc = await dn.collections.getItem(kb.id, p.item, { includeText: true });
    const bytes = new TextEncoder().encode(doc.text ?? '');
    const quoted: string = new TextDecoder().decode(bytes.subarray(p.byteStart, p.byteEnd));
    void quoted;
  }

  const found = await dn.collections.search(kb.id, { query: 'receipts for claims over 500 SEK', scope: 'M-42', topK: 3 });
  for (const p of found.passages) console.log(p.title, p.score, p.text);

  const ids: string[] = await dn.uploadDocuments([Document.fromPath('./handbook.docx')]);
  await dn.collections.addDocument(kb.id, { document: Document.fromUploadId(ids[0]!), title: 'Handbook' });
  await dn.collections.deleteFailed(kb.id);
  const page = await dn.collections.listChunks(kb.id, policy.id, { limit: 20 });
  page.chunks[0]?.byte_start;
  const item: CollectionItem = ready;
  const all: Collection = await dn.collections.waitUntilReady(kb.id);
  void item;
  void all;
}
