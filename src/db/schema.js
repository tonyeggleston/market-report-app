import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

let db;

export function initDb() {
  const dbDir = path.join(app.getPath('userData'), 'market-report');
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

  db = new Database(path.join(dbDir, 'reports.db'));
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_address TEXT NOT NULL,
      run_date TEXT NOT NULL DEFAULT (datetime('now')),
      data_json TEXT NOT NULL,
      email_body TEXT,
      cma_pdf_path TEXT,
      subject_profile_json TEXT
    );

    CREATE TABLE IF NOT EXISTS comps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id INTEGER NOT NULL REFERENCES reports(id),
      mls_number TEXT,
      address TEXT,
      sqft INTEGER,
      year_built INTEGER,
      lot_acres REAL,
      has_pool INTEGER,
      price REAL,
      status TEXT,
      days_on_market INTEGER,
      flag TEXT,
      description TEXT,
      big_ticket_items TEXT,
      included INTEGER DEFAULT 0,
      user_override INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS comp_vision (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      comp_id INTEGER NOT NULL REFERENCES comps(id),
      report_id INTEGER NOT NULL REFERENCES reports(id),
      mls_number TEXT,
      photo_count INTEGER,
      analysis_json TEXT,
      match_score REAL,
      include_recommendation INTEGER,
      override_include INTEGER,
      overall_update_level TEXT,
      red_flags TEXT,
      reasoning TEXT,
      generated_description TEXT,
      edited_description TEXT
    );

    CREATE TABLE IF NOT EXISTS showings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id INTEGER NOT NULL REFERENCES reports(id),
      showing_date TEXT,
      showing_time TEXT,
      agent_name TEXT,
      brokerage TEXT,
      status TEXT,
      is_team_member INTEGER DEFAULT 0,
      is_open_house INTEGER DEFAULT 0,
      feedback_rating TEXT,
      feedback_comments TEXT,
      feedback_offer_intent TEXT
    );

    CREATE TABLE IF NOT EXISTS market_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id INTEGER NOT NULL REFERENCES reports(id),
      total_area_showings INTEGER,
      active_listing_count INTEGER,
      active_count_price_search INTEGER,
      showings_per_listing REAL,
      avg_dom_active INTEGER,
      max_dom_active INTEGER,
      min_dom_active INTEGER,
      avg_dom_closed INTEGER,
      avg_sold_price REAL,
      price_range_min REAL,
      price_range_max REAL,
      our_dom INTEGER,
      list_date TEXT,
      total_showings_since_live INTEGER
    );
  `);

  return db;
}

export function getDb() {
  return db;
}
