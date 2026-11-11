use crate::Result;
use rusqlite::{
    params_from_iter,
    types::{Value as Sql, ValueRef},
    Connection,
};
use serde_json::{json, Value};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{fs, path::Path};
pub struct Db(pub Connection);
impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        if fs::symlink_metadata(path)
            .map(|m| !m.is_file() || m.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err("Invalid database path".into());
        }
        let db = Connection::open(path)?;
        #[cfg(unix)]
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;")?;
        Ok(Self(db))
    }
    pub fn memory() -> Result<Self> {
        Ok(Self(Connection::open_in_memory()?))
    }
    pub fn exec(&self, sql: &str, args: &[Value]) -> Result<Vec<Value>> {
        let args: Vec<Sql> = args
            .iter()
            .map(|v| match v {
                Value::Null => Sql::Null,
                Value::Bool(b) => Sql::Integer(i64::from(*b)),
                Value::Number(n) => n
                    .as_i64()
                    .map(Sql::Integer)
                    .unwrap_or_else(|| Sql::Real(n.as_f64().unwrap_or(0.0))),
                Value::String(s) => Sql::Text(s.clone()),
                _ => Sql::Text(v.to_string()),
            })
            .collect();
        let mut statement = self.0.prepare(sql)?;
        if statement.column_count() == 0 {
            statement.execute(params_from_iter(args))?;
            return Ok(vec![]);
        }
        let names: Vec<String> = statement
            .column_names()
            .iter()
            .map(|s| s.to_string())
            .collect();
        let rows = statement.query_map(params_from_iter(args), |row| {
            let mut value = serde_json::Map::new();
            for (i, name) in names.iter().enumerate() {
                value.insert(
                    name.clone(),
                    match row.get_ref(i)? {
                        ValueRef::Null => Value::Null,
                        ValueRef::Integer(n) => json!(n),
                        ValueRef::Real(n) => json!(n),
                        ValueRef::Text(s) => json!(String::from_utf8_lossy(s)),
                        ValueRef::Blob(_) => Value::Null,
                    },
                );
            }
            Ok(Value::Object(value))
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    pub fn one(&self, sql: &str, args: &[Value]) -> Result<Value> {
        Ok(self
            .exec(sql, args)?
            .into_iter()
            .next()
            .unwrap_or(Value::Null))
    }
    pub fn transaction<T>(&self, f: impl FnOnce() -> Result<T>) -> Result<T> {
        self.0.execute_batch("BEGIN IMMEDIATE")?;
        match f() {
            Ok(v) => {
                self.0.execute_batch("COMMIT")?;
                Ok(v)
            }
            Err(e) => {
                let _ = self.0.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }
}
