import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient } from "mongodb";
import { matchesSeriesSearch } from "../src/utils/text-search.js";
import { sortRecords } from "../src/db/posts.js";
const fixtures = [
  { _id: "01", title: "Walking through cafés", description: "Travel diaries from Kolkata", searchBy: ["books", "walking"] },
  { _id: "02", title: "A book about Kolkata", description: "Quiet rivers", searchBy: ["reading"] },
  { _id: "03", title: "কলকাতা ভ্রমণ", description: "একটি বাংলা গল্প।", searchBy: ["বাংলা", "ভ্রমণ"] },
  { _id: "04", title: "Blueberry notes", description: "The café is closed", searchBy: ["travel"] },
  { _id: "05", title: "Writer's notes", description: "Running runners run", searchBy: ["A.B", "sea-side", "co-operating"] },
  { _id: "06", title: "The and a", description: "nothing more", searchBy: [] },
  { _id: "07", title: "COFFEE Café", description: "walk in the park", searchBy: ["বাংলাদেশ"] }
];
describe.skipIf(!process.env.RUN_MONGO_PARITY)("MongoDB reference parity (synthetic data only)", () => {
  let server: MongoMemoryServer, client: MongoClient;
  beforeAll(async () => {
    server = await MongoMemoryServer.create({ instance: { dbName: "batayan_parity" } });
    client = new MongoClient(server.getUri()); await client.connect();
    const collection = client.db().collection<(typeof fixtures)[number]>("series");
    await collection.createIndex({ title: "text", description: "text", searchBy: "text" });
    await collection.insertMany(fixtures);
  }, 180000);
  afterAll(async () => { await client?.close(); await server?.stop(); });
  it.each([
    "walk", "walking", "WALK", "books", "missing books", "the", "the and", "cafe", "CAFÉ", "blue", "blueberry",
    "কলকাতা", "বাংলা", "ভ্রমণ", "কল", "run", "reading", "notes -blueberry", "-notes", '"A book"',
    '"a book" missing', '"walk in the park"', '"walk park"', '"quiet rivers"', '"quiet rivers" -kolkata',
    '"A book" "quiet rivers"', 'notes -"blueberry notes"', "A.B", "sea-side", "co-operating", "writer's"
  ])("matches MongoDB text-search results for %s", async query => {
    const expected = (await client.db().collection("series").find({ $text: { $search: query } }).toArray()).map(row => row._id).sort();
    const actual = fixtures.filter(row => matchesSeriesSearch([row.title, row.description, ...row.searchBy], query)).map(row => row._id).sort();
    expect(actual).toEqual(expected);
  });
  it("uses MongoDB simple collation for Bengali/English titles with a stable ID tie-break", async () => {
    const expected = (await client.db().collection("series").find().sort({ title: 1, _id: 1 }).toArray()).map(row => row._id);
    expect(sortRecords(structuredClone(fixtures), "title", true).map(row => row._id)).toEqual(expected);
  });
});
