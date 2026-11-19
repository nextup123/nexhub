'use strict';

// Sample enquiries for trying the dashboard on the in-memory hub (SEED=1 node test/serve-fake.js).
// Made-up people and companies; nothing here is real.
const crypto = require('crypto');

const PEOPLE = [
  ['Rakesh Sharma', 'Sharma Auto Components', 'Automotive and auto components', 'NexR20', 'We run 3 spot-welding stations for seat frames, 2 shifts. Looking to automate the loading and welding of brackets. Cycle time today is 48 s per part.'],
  ['Priya Nair', 'Kerala Precision Castings', 'Metal fabrication and casting', 'NexR10', 'Need a robot for fettling and grinding small castings (2 to 6 kg). Dust is heavy in the shop. Can you visit our plant in Kochi?'],
  ['Amit Verma', 'Verma CNC Works', 'CNC machining', 'NexC5', 'Machine tending for two VMCs. Operator loads 1 part every 3 minutes. Want a cobot that can run the lunch break and night shift.'],
  ['Sunita Gupta', 'Gupta Glass Industries', 'Glass processing', 'Custom automation', 'Handling of 6 mm toughened glass sheets from the cutting table to the edging machine. Sheet size up to 1200 x 900.'],
  ['Mohammed Irfan', 'Irfan Powder Coaters', 'Coating and finishing', 'NexR10', 'Spray painting of steel almirah doors. Want consistent coat thickness and less paint wastage. What is the payback period?'],
  ['Karan Mehta', 'Mehta Fabricators', 'Metal fabrication and casting', 'NexR20', 'MIG welding of heavy frames for agricultural trailers. Interested in a demo at your Ghaziabad facility next week.'],
  ['Neha Singh', 'Singh Plastics', 'General manufacturing', 'NexC5', 'Pick and place from injection moulding machine to conveyor. 22 s cycle. Is the NexC5 fast enough?'],
  ['Arjun Reddy', 'Deccan Motors Pvt Ltd', 'Automotive and auto components', 'NexR20', 'Palletising of gearbox housings, 18 kg each, 4 layers per pallet. Need a quote for 2 cells.'],
  ['Vikram Joshi', '', 'Other', 'Not sure yet', 'I am a student at IIT Delhi working on a robotics project. Do you offer internships or demo units for colleges?'],
  ['Deepa Krishnan', 'Chennai Auto Stampings', 'Automotive and auto components', 'NexC5', 'Press tending on a 100 T press. Safety is our main concern, operators still lose fingers in the industry. Can a cobot work next to people here?'],
  ['Rohit Bansal', 'Bansal Steel Furniture', 'Coating and finishing', 'NexR10', 'Looking for a painting robot for chairs and tables. Batch sizes are small and change every day. How long does it take to teach a new part?'],
  ['Farhan Qureshi', 'Qureshi Engineering', 'CNC machining', 'NexC5', 'Deburring of aluminium housings after CNC. 400 parts per day.'],
  ['Anjali Desai', 'Desai Packaging', 'General manufacturing', 'Custom automation', 'End-of-line packing: cartons to pallet, 12 kg per carton, 8 per minute. Please call me after 4 pm.'],
  ['Suresh Patel', 'Patel Foundry', 'Metal fabrication and casting', 'NexR20', 'Ladle pouring automation. Is this something you have done before? Temperature near the robot is high.'],
  ['Harpreet Kaur', 'Punjab Tractors Ancillary', 'Automotive and auto components', 'NexR10', 'Welding of hydraulic lift arms. We have 2 manual welders now. Need training for our team as well.'],
  ['Manoj Tiwari', 'Tiwari Glass Works', 'Glass processing', 'NexR20', 'Loading glass into the tempering furnace. What gripper do you use for glass?'],
  ['Kavita Rao', 'Rao Electricals', 'General manufacturing', 'NexC5', 'Screwdriving on switchboard assemblies, 8 screws per board. Need high accuracy.'],
  ['Sanjay Kumar', 'SK Metal Polishers', 'Coating and finishing', 'Not sure yet', 'Buffing and polishing of stainless steel utensils. Is a robot right for this or should we use a special purpose machine?'],
  ['Ritu Agarwal', 'Agarwal Forgings', 'Metal fabrication and casting', 'NexR20', 'Forging press loading, parts at 1100 C, 9 kg. Please send the NexR20 brochure and price.'],
  ['Nikhil Saxena', 'Saxena Auto Parts', 'Automotive and auto components', 'NexC5', 'Quality inspection with a camera on a cobot. Do you integrate vision systems?'],
  ['Pooja Malhotra', 'Malhotra Exports', 'General manufacturing', 'Custom automation', 'Following up on our call last week. Could you share the layout drawing for the packing cell?'],
  ['Ajay Chauhan', 'Chauhan Industries', 'CNC machining', 'NexR10', 'Lathe tending for shafts up to 600 mm. 3 lathes in a row. Can one robot serve all three?'],
];
const STATUS_FOR_AGE = (days, i) => {
  if (days < 1.2) return i % 3 === 0 ? 'in_progress' : 'new';
  if (days < 4) return ['new', 'in_progress', 'replied', 'replied'][i % 4];
  return ['replied', 'closed', 'replied', 'closed', 'in_progress'][i % 5];
};

async function seedContacts(db) {
  const col = db.collection('contact_submissions');
  const now = Date.now();
  const hour = 3600 * 1000;
  // Spread over 40 days, more recent ones closer together.
  const ages = PEOPLE.map((_, i) => (i < 4 ? [0.08, 0.4, 0.9, 1.6][i] : 2 + (i - 4) * 2.1 + (i % 3) * 0.4) * 24 * hour);
  for (let i = 0; i < PEOPLE.length; i += 1) {
    const [name, company, industry, product, message] = PEOPLE[i];
    const createdAt = new Date(now - ages[i]);
    const days = ages[i] / (24 * hour);
    const status = STATUS_FOR_AGE(days, i);
    const first = name.split(' ')[0].toLowerCase();
    const history = [{ status: 'new', by: 'website', at: createdAt }];
    if (status !== 'new') history.push({ status: status === 'closed' ? 'replied' : status, by: 'Dhirendra', at: new Date(createdAt.getTime() + (2 + (i % 7) * 3) * hour) });
    if (status === 'closed') history.push({ status: 'closed', by: 'Dhirendra', at: new Date(createdAt.getTime() + 3 * 24 * hour) });
    await col.insertOne({
      _id: crypto.randomUUID(),
      ref: `ENQ-${i + 1}`,
      seq: i + 1,
      name,
      email: i % 5 === 3 ? null : `${first}@${(company || 'gmail').toLowerCase().replace(/[^a-z]+/g, '').slice(0, 14) || 'gmail'}.in`,
      phone: i % 4 === 1 ? null : `+91 98${String(10000000 + i * 7654321).slice(0, 3)} ${String(10000 + i * 3571).slice(0, 5)}`,
      company,
      industry,
      product,
      message,
      source: { page: i % 3 ? `/contact?product=${product === 'NexC5' ? 'cobot' : 'robot'}` : '/contact', referrer: i % 2 ? 'https://www.google.com/' : '', utm: '' },
      status,
      starred: i % 6 === 0,
      readAt: status === 'new' && i % 2 === 0 ? null : new Date(createdAt.getTime() + hour),
      assignee: status === 'new' ? null : 'Dhirendra',
      tags: [],
      notes: status === 'new' ? [] : [{ id: crypto.randomUUID(), author: 'Dhirendra', text: i % 2 ? 'Called, sent brochure on WhatsApp.' : 'Asked for photos of the part and the current cycle time.', at: new Date(createdAt.getTime() + 3 * hour) }],
      statusHistory: history,
      messageHash: crypto.createHash('sha256').update(message).digest('hex').slice(0, 32),
      ipHash: crypto.createHash('sha256').update(`seed${i}`).digest('hex').slice(0, 32),
      userAgent: 'seed',
      createdAt,
      updatedAt: createdAt,
    });
  }
  // Two spam messages that slipped past the filters.
  for (const [j, msg] of ['Get 10,000 backlinks for your website cheap!!! Visit our site', 'Crypto investment opportunity guaranteed 300% returns'].entries()) {
    const createdAt = new Date(now - (3 + j * 9) * 24 * hour);
    await col.insertOne({
      _id: crypto.randomUUID(), ref: `ENQ-${PEOPLE.length + j + 1}`, seq: PEOPLE.length + j + 1,
      name: j ? 'Investment Team' : 'SEO Expert', email: j ? 'profit@crypto-gains.biz' : 'seo@rank-fast.biz', phone: null,
      company: '', industry: 'Other', product: 'Not sure yet', message: msg, source: { page: '/contact', referrer: '', utm: '' },
      status: 'spam', starred: false, readAt: createdAt, assignee: null, tags: [], notes: [],
      statusHistory: [{ status: 'new', by: 'website', at: createdAt }, { status: 'spam', by: 'Dhirendra', at: createdAt }],
      messageHash: `spam${j}`, ipHash: `spam${j}`, userAgent: 'seed', createdAt, updatedAt: createdAt,
    });
  }
  await db.collection('counters').updateOne({ _id: 'contact' }, { $set: { seq: PEOPLE.length + 2 } }, { upsert: true });
}

module.exports = { seedContacts };
