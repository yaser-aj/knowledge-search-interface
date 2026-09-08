import { cosine, embedAll } from "@/lib/embeddings";

const [gcc, doha, cake] = await embedAll([
  "a business headquartered somewhere in the GCC",
  "our head office sits in Doha, Qatar",
  "recipe for a lemon sponge cake",
]);

console.log("dim", gcc.length);
console.log("gcc vs doha", cosine(gcc, doha).toFixed(4));
console.log("gcc vs cake", cosine(gcc, cake).toFixed(4));
