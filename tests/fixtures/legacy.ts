// Synthetic records with the same shape as the exports; no copied account data.
export const post = {
  _id: "507f1f77bcf86cd799439011", title: "কলকাতা", postType: "travel",
  gist: "A synthetic journal", createdAt: "2020-07-06T22:33:02.405Z",
  visited: 5, liked: 2, photoHero: "photo_example.jpg", gallery: [],
  content: [{ _id: "507f1f77bcf86cd799439012", header: "সকাল", content: "একটি গল্প।\nSecond line.", image: "", imgDescription: "", video: "", videoDescription: "" }],
  searchBy: ["Kolkata", "a.b"], additionalInfo: ""
};
export const user = { _id: "507f1f77bcf86cd799439013", name: "Example", email: "example@example.com", role: "user", createdAt: "2020-07-06T22:33:02.405Z" };
export const comment = { _id: "507f1f77bcf86cd799439014", post: post._id, username: "Reader", title: "Note", description: "Synthetic comment", createdAt: post.createdAt, reply: "" };
