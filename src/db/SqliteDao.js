require("es6-promise");
var sqlite3 = require("sqlite3");

var Log = require("plugbotbase").Log;

var LOG = new Log("SqliteDao");
var INSTANCE = null;

var CREATE_TABLE_USERS_SQL = "CREATE TABLE users (\n"
                           + "    id VARCHAR(30) NOT NULL PRIMARY KEY,\n"
                           + "    username VARCHAR(100) NOT NULL\n"
                           + ");";

var CREATE_TABLE_MEDIA_PLAYS_SQL = "CREATE TABLE media_plays (\n"
                                 + "    play_id INTEGER NOT NULL PRIMARY KEY,\n"
                                 + "    user_id VARCHAR(30) NOT NULL,\n"
                                 + "    video_id VARCHAR(15) NOT NULL,\n"
                                 + "    title VARCHAR(200) NOT NULL,\n"
                                 + "    duration INTEGER NOT NULL,\n"
                                 + "    played_on datetime NOT NULL\n"
                                 + ");";

var CREATE_TABLE_MEDIA_VOTES_SQL = "CREATE TABLE media_votes (\n"
                                 + "    user_id VARCHAR(30) NOT NULL,\n"
                                 + "    play_id VARCHAR(15) NOT NULL,\n"
                                 + "    vote TINYINT NOT NULL,\n"
                                 + "    voted_on datetime NOT NULL DEFAULT current_timestamp,\n"
                                 + "    FOREIGN KEY (user_id) REFERENCES users(user_id),\n"
                                 + "    FOREIGN KEY (play_id) REFERENCES media_plays(play_id),\n"
                                 + "    PRIMARY KEY (user_id, play_id),\n"
                                 + "    CONSTRAINT chk_vote CHECK (vote == 1 OR vote == -1)\n"
                                 + ");";

var GET_TOTAL_PLAYS_FOR_USER_SQL = "SELECT COUNT(*) as num_plays FROM media_plays WHERE user_id = ?";
var GET_INCOMING_VOTES_FOR_USER_SQL = "SELECT COUNT(*) as num_votes, vote FROM media_votes mv JOIN media_plays mp USING (play_id) WHERE mp.user_id = ? GROUP BY vote";
var GET_OUTGOING_VOTES_FOR_USER_SQL = "SELECT COUNT(*) as num_votes, vote FROM media_votes WHERE user_id = ? GROUP BY vote";
var INSERT_MEDIA_PLAY_SQL = "INSERT INTO media_plays (video_id, user_id, title, duration, played_on) VALUES (?, ?, ?, ?, ?)";
var INSERT_MEDIA_VOTE_SQL = "INSERT OR REPLACE INTO media_votes (play_id, user_id, vote) VALUES (?, ?, ?)";
var INSERT_USER_SQL = "INSERT OR REPLACE INTO users (id, username) VALUES (?, ?)";

/**
 * Retrieves a singleton instance of the DAO.
 *
 * @param {string} dbFilePath - The path to where the database file should be stored
 * @returns {object} An instance of the DAO
 */
function getInstance(dbFilePath) {
    if (!dbFilePath || typeof dbFilePath !== "string") {
        throw new Error("getInstance was called without a String argument");
    }

    if (!INSTANCE) {
        INSTANCE = new SqliteDao(dbFilePath);
    }

    return INSTANCE;
}

/**
 * Constructs an instance of the DAO. Prepares SQL statements and performs checks to
 * ensure the database file exists and has the proper tables in it. If not, the file
 * will be created and populated with the necessary tables.
 *
 * @param {string} dbFilePath - The path to where the database file should be stored
 * @returns {object} An instance of the DAO
 */
function SqliteDao(dbFilePath) {
    var GET_INCOMING_VOTES_FOR_USER_STMT;
    var GET_OUTGOING_VOTES_FOR_USER_STMT;
    var GET_TOTAL_PLAYS_FOR_USER_STMT;
    var INSERT_MEDIA_PLAY_STATEMENT;
    var INSERT_MEDIA_VOTE_STATEMENT;
    var INSERT_USER_STATEMENT;

    LOG.info("Attempting to create new DAO with database file path {}", dbFilePath);

    // Attempt to open an existing file at the given path; if that fails, we have to create a new
    // one, and then
    var dbPromise = _createDatabase(dbFilePath, sqlite3.OPEN_READWRITE).catch(function(err) {
        LOG.info("Initial database creation failed; trying again by creating a new database file");

        return _createDatabase(dbFilePath, sqlite3.OPEN_CREATE | sqlite3.OPEN_READWRITE).then(function(db) {
            var createUsersPromise = new Promise(function(resolve, reject) {
                db.run(CREATE_TABLE_USERS_SQL, function() { resolve(db); });
            });

            var createMediaPlaysPromise = new Promise(function(resolve, reject) {
                db.run(CREATE_TABLE_MEDIA_PLAYS_SQL, function() { LOG.info("{}", arguments); resolve(db); });
            });

            var createMediaVotesPromise = new Promise(function(resolve, reject) {
                db.run(CREATE_TABLE_MEDIA_VOTES_SQL, function() { resolve(db); });
            });

            return createUsersPromise.then(createMediaPlaysPromise).then(createMediaVotesPromise);
        });
    }).then(function(db) {
        GET_INCOMING_VOTES_FOR_USER_STMT = db.prepare(GET_INCOMING_VOTES_FOR_USER_SQL);
        GET_OUTGOING_VOTES_FOR_USER_STMT = db.prepare(GET_OUTGOING_VOTES_FOR_USER_SQL);
        GET_TOTAL_PLAYS_FOR_USER_STMT = db.prepare(GET_TOTAL_PLAYS_FOR_USER_SQL);
        INSERT_MEDIA_PLAY_STATEMENT = db.prepare(INSERT_MEDIA_PLAY_SQL);
        INSERT_MEDIA_VOTE_STATEMENT = db.prepare(INSERT_MEDIA_VOTE_SQL);
        INSERT_USER_STATEMENT = db.prepare(INSERT_USER_SQL);

        LOG.info("DAO created successfully");
    });

    /**
     * Retrieves how many votes a user has had cast on their songs, grouped by type.
     *
     * @param {integer} userID - The ID of the user to look up
     * @returns {Promise} A promise for an object in the form
     *
     * {
     *     woots: 123,
     *     mehs: 321
     * }
     */
    this.getNumberOfIncomingVotesForUser = function(userID) {
        return dbPromise.then(function(db) {
            return new Promise(function(resolve, reject) {
                GET_INCOMING_VOTES_FOR_USER_STMT.all([userID], function(err, rows) {
                    var obj = { woots: 0, mehs: 0 };
                    if (err) {
                        LOG.error("An error occurred while querying for incoming votes for userID={}: {}", userID, err);
                        resolve(obj);
                        return;
                    }

                    if (rows.length > 0) {
                        if (rows[0].vote === -1) {
                            obj.mehs = rows[0].num_votes;
                        }
                        else {
                            obj.woots = rows[0].num_votes;
                        }
                    }

                    if (rows.length > 1) {
                        if (rows[1].vote === -1) {
                            obj.mehs = rows[1].num_votes;
                        }
                        else {
                            obj.woots = rows[1].num_votes;
                        }
                    }

                    resolve(obj);
                });
            });
        });
    };

    /**
     * Gets the total number of times the user has played a song in the room.
     *
     * @param {integer} userID - The ID of the user to look up
     * @returns {Promise} A promise for the number of plays the user has
     */
    this.getNumberOfPlaysByUser = function(userID) {
        return dbPromise.then(function(db) {
            return new Promise(function(resolve, reject) {
                GET_TOTAL_PLAYS_FOR_USER_STMT.all([userID], function(err, rows) {
                    if (err) {
                        LOG.error("An error occurred while querying for number of plays by userID={}: {}", userID, err);
                        resolve(0);
                        return;
                    }

                    if (rows.length > 0) {
                        resolve(rows[0].num_plays);
                    }
                    else {
                        resolve(0);
                    }
                });
            });
        });
    };

    /**
     * Retrieves how many votes a user has cast, grouped by type.
     *
     * @param {integer} userID - The ID of the user to look up
     * @returns {Promise} A promise for an object in the form
     *
     * {
     *     woots: 123,
     *     mehs: 321
     * }
     */
    this.getNumberOfVotesCastByUser = function(userID) {
        return dbPromise.then(function(db) {
            return new Promise(function(resolve, reject) {
                GET_OUTGOING_VOTES_FOR_USER_STMT.all([userID], function(err, rows) {
                    var obj = { woots: 0, mehs: 0 };
                    if (err) {
                        LOG.error("An error occurred while querying for votes cast by userID={}: {}", userID, err);
                        resolve(obj);
                        return;
                    }

                    if (rows.length > 0) {
                        if (rows[0].vote === -1) {
                            obj.mehs = rows[0].num_votes;
                        }
                        else {
                            obj.woots = rows[0].num_votes;
                        }
                    }

                    if (rows.length > 1) {
                        if (rows[1].vote === -1) {
                            obj.mehs = rows[1].num_votes;
                        }
                        else {
                            obj.woots = rows[1].num_votes;
                        }
                    }

                    resolve(obj);
                });
            });
        });
    };

    /**
     * Inserts a media play record to the database.
     *
     * @param {object} play - An object with properties 'videoID', 'userID', 'title', 'playedOn' and 'duration'
     * @returns {Promise} A Promise for an object with a lastID property representing the row added
     */
    this.insertMediaPlay = function(play) {
        LOG.info("Attempting to insert media play: {}", play);
        return dbPromise.then(function(db) {
            return new Promise(function(resolve, reject) {
                INSERT_MEDIA_PLAY_STATEMENT.run([play.videoID, play.userID, play.title, play.duration, play.playedOn], function(err) {
                    if (err) {
                        LOG.info("Error occurred when inserting media play {}. The error: {}", play, err);
                        reject(err);
                    }
                    else {
                        LOG.info("Successfully inserted media play: {}", play);
                        resolve(this);
                    }
                });
            });
        });
    };

    /**
     * Upserts a media vote record to the database. (If it already exists, it will be updated; otherwise it will be inserted.)
     *
     * @param {object} vote - An object with properties 'playId', 'userId', and 'vote'
     * @returns {Promise} A Promise for an object with a 'lastID' property representing the row added, if new, or a 'changes' property if updated
     */
    this.upsertMediaVote = function(vote) {
        LOG.info("Attempting to upsert media vote: {}", vote);
        return dbPromise.then(function(db) {
            return new Promise(function(resolve, reject) {
                INSERT_MEDIA_VOTE_STATEMENT.run([vote.playID, vote.userID, vote.vote], function(err) {
                    if (err) {
                        LOG.info("Error occurred when upserting media vote {}. The error: {}", vote, err);
                        reject(err);
                    }
                    else {
                        LOG.info("Successfully upserted media vote: {}", vote);
                        resolve(this);
                    }
                });
            });
        });
    };

    /**
     * Upserts a user record to the database. (If it already exists, it will be updated; otherwise it will be inserted.)
     *
     * @param {object} user - An object with properties 'userID' and 'username'
     * @returns {Promise} A Promise for an object with a lastID property representing the row added, if new, or a 'changes' property if updated
     */
    this.upsertUser = function(user) {
        LOG.info("Attempting to upsert user: {}", user);
        return dbPromise.then(function(db) {
            return new Promise(function(resolve, reject) {
                INSERT_USER_STATEMENT.run([user.userID, user.username], function(err) {
                    if (err) {
                        LOG.info("Error occurred when upserting user {}. The error: {}", user, err);
                        reject(err);
                    }
                    else {
                        LOG.info("Successfully upserted user: {}", user);
                        resolve(this);
                    }
                });
            });
        });
    };
}

/**
 * Creates a Sqlite3 Database and wraps it in a Promise.
 *
 * @param {string} dbFilePath - Path to the database file to open or create
 * @param {integer} openMode - A bit flag composed of the Sqlite3 database opening mode constants
 * @returns {Promise} A Promise for the database object, which will reject if the database creation fails
 */
function _createDatabase(dbFilePath, openMode) {
    return new Promise(function(resolve, reject) {
        var db = new sqlite3.Database(dbFilePath, openMode, function(err) {
            if (err) {
                reject(err);
            }
            else {
                resolve(db);
            }
        });
    });
}

exports.getInstance = getInstance;
