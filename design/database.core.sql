-- folder database
CREATE TABLE folder (
  `id` CHAR(36) PRIMARY KEY NOT NULL,
  `pid` CHAR(36) NOT NULL,
  `level` TINYINT UNSIGNED NOT NULL,
  `name` NVARCHAR(128) NOT NULL,
  `locked` TINYINT UNSIGNED DEFAULT 0,
  `total` SMALLINT UNSIGNED  DEFAULT 0
);

-- note database
CREATE TABLE note (
  `id` CHAR(36) PRIMARY KEY NOT NULL,
  `title` NVARCHAR(140) NOT NULL,
  `type` CHAR(1) NOT NULL,    -- 'R' 'M' 
  `c_time` DATETIME NOT NULL,
  `u_time` DATETIME NOT NULL,
  `weight` TIMESTAMP DEFAULT 0,
  `locked` TINYINT UNSIGNED NOT NULL,
  `word_count` INT UNSIGNED NOT 0,
  `author` NVARCHAR(28) DEFAULT NULL,
  `origin` VARCHAR(255) DEFAULT NULL,
  `lisence` VARCHAR(16) DEFAULT NULL,
  `remark` NVARCHAR(800) DEFAULT NULL,
  `content` TEXT NOT NULL,
  `version` INT UNSIGNED DEFAULT 1
)

CREATE TABLE tag_meta (
  `id` CHAR(36) PRIMARY KEY NOT NULL,
  `name` NVARCHAR(32) NOT NULL
);

CREATE TABLE tag (
  `nid` CHAR(36) PRIMARY KEY NOT NULL,
  `fid` CHAR(36) NOT NULL,
  `tid` CHAR(36) NOT NULL,
  `title` NVARCHAR(140) NOT NULL
);

CREATE TABLE star (
  `nid` CHAR(36) PRIMARY KEY NOT NULL,
  `fid` CHAR(36) NOT NULL,
  `title` NVARCHAR(140) NOT NULL
);

CREATE TABLE history (
  `id` INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  `nid` CHAR(36) NOT NULL,
  `when` DATETIME NOT NULL,
  `content` TEXT NOT NULL
);

CREATE TABLE trash (
  `nid` CHAR(36) PRIMARY KEY NOT NULL,
  `fid` CHAR(36) NOT NULL,
  `title` NVARCHAR(140) NOT NULL,
  `type` CHAR(1) NOT NULL,    -- 'R' 'M' 
  `c_time` DATETIME NOT NULL,
  `u_time` DATETIME NOT NULL,
  `weight` TIMESTAMP DEFAULT 0,
  `locked` TINYINT UNSIGNED DEFAULT 0,
  `word_count` INT UNSIGNED DEFAULT 0,
  `author` NVARCHAR(28) DEFAULT NULL,
  `origin` VARCHAR(255) DEFAULT NULL,
  `lisence` VARCHAR(16) DEFAULT NULL,
  `remark` NVARCHAR(800) DEFAULT NULL,
  `content` TEXT NOT NULL,
  `version` INT UNSIGNED DEFAULT 1
);

