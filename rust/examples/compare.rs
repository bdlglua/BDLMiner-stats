//! Test oracle bridge: deterministic operations, no network or persistent files.
use bdlminer_stats::{db::Db, parse_report, public::Store};
use serde_json::Value;
use std::io::{self, Read};
fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    let scenarios: Vec<Value> = serde_json::from_str(&input).unwrap();
    let mut outputs = Vec::new();
    for scenario in scenarios {
        let now = scenario["now"].as_i64().unwrap();
        let mut store = Store::new(Db::memory().unwrap(), now).unwrap();
        let mut values = Vec::new();
        for op in scenario["operations"].as_array().unwrap() {
            let now = op["at"].as_i64().unwrap();
            if let Some(report) = op.get("report") {
                store.add(&parse_report(report).unwrap(), now).unwrap();
            } else {
                values.push(store.summary(now).unwrap());
            }
        }
        outputs.push(values);
    }
    println!("{}", serde_json::to_string(&outputs).unwrap());
}
