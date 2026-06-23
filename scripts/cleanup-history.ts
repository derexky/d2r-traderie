import * as admin from 'firebase-admin';
// eslint-disable-next-line @typescript-eslint/no-require-imports
admin.initializeApp({ credential: admin.credential.cert(require('../serviceAccount.json')) });
const db = admin.firestore();

const COMBOS = ['ladder_sc', 'ladder_hc', 'nonladder_sc', 'nonladder_hc'];

async function main() {
  const items = await db.collection('price_snapshots').listDocuments();
  console.log(`Found ${items.length} items`);

  for (const itemRef of items) {
    for (const combo of COMBOS) {
      const snap = await itemRef.collection(combo).orderBy('synced_at', 'desc').get();
      if (snap.size <= 1) continue;

      const toDelete = snap.docs.slice(1); // keep first (newest), delete rest
      const batch = db.batch();
      toDelete.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      console.log(`${itemRef.id}/${combo}: deleted ${toDelete.length} old docs`);
    }
  }
  console.log('Done');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
