}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 { let mut x = self.0; x ^= x << 13; x ^= x >> 7; x ^= x << 17; self.0 = x; x }
    fn below(&mut self, n: u64) -> u64 { self.next() % n }
}

fn main() {
    let mut rng = Rng(0x9E3779B97F4A7C15);
    let mut checked_none = 0u64;
    let mut checked_some = 0u64;
    let mut accepted = 0u64;
    for round in 0..300_000u64 {
        let limit = [1u32, 100, 1000, 5000, 50000][rng.below(5) as usize];
        let problem = Problem { character: Character { weight_limit_lt: limit } };
        let mut ck = Ck { stints: Vec::new(), boarding_scratch: RefCell::new(Vec::new()) };
        let pushes = 1 + rng.below(6);
        for _ in 0..pushes {
            let candidate = random_stint(&mut rng);
            let base = ck.character_accepts(&problem, &candidate);
            let new = ck.character_accepts_replacing(&problem, &candidate, None);
            checked_none += 1;
            if base != new {
                println!("MISMATCH none round {round} limit {limit}\n state {:?}\n added {:?}\n base {base} new {new}", ck.stints, candidate);
                std::process::exit(1);
            }
            if base { ck.stints.push(candidate); accepted += 1; }
            // Replacement property: replacing entry i must equal checking without it.
            if !ck.stints.is_empty() {
                let i = rng.below(ck.stints.len() as u64) as usize;
                let candidate = random_stint(&mut rng);
                let mut without = ck.stints.clone();
                without.remove(i);
                let base = ck.character_accepts(&Problem { character: problem.character }, &candidate); // placeholder, replaced below
                let base = { let mut c2 = Ck { stints: without, boarding_scratch: RefCell::new(Vec::new()) }; c2.character_accepts(&problem, &candidate) };
                let new = ck.character_accepts_replacing(&problem, &candidate, Some(i));
                checked_some += 1;
                if base != new {
                    println!("MISMATCH replace round {round} limit {limit} i {i}\n state {:?}\n added {:?}\n base {base} new {new}", ck.stints, candidate);
                    std::process::exit(1);
                }
            }
        }
    }
    println!("OK: {checked_none} no-replacement checks, {checked_some} replacement checks, {accepted} accepted stints; no divergence");
}

fn random_stint(rng: &mut Rng) -> Stint {
    let from = rng.below(9) as u16;
    let to = from + 1 + rng.below(6) as u16;
    let tier = (1 + rng.below(7)) as u8;
    let count = (1 + rng.below(12)) as u8;
    // Mix realistic whole-item weights with arbitrary ones to stress the weight sums.
    let item = if rng.below(2) == 0 { 1 + rng.below(60) as i64 } else { 10 };
    Stint {
        lot: rng.below(4) as u16,
        tier,
        count,
        weight_lt: i64::from(count) * item,
        from,
        to,
        boards_directly: rng.below(2) == 0,
        into_storage: rng.below(2) == 0,
    }
}
