import sqlalchemy

metadata = sqlalchemy.MetaData()

nodes = sqlalchemy.Table(
    "nodes",
    metadata,
    sqlalchemy.Column("id", sqlalchemy.Integer, primary_key=True, autoincrement=True),
    sqlalchemy.Column("name", sqlalchemy.String(128), nullable=False),
    sqlalchemy.Column("host", sqlalchemy.String(256), nullable=False),
    sqlalchemy.Column("port", sqlalchemy.Integer, default=22),
    sqlalchemy.Column("username", sqlalchemy.String(128), nullable=False),
    sqlalchemy.Column("auth_type", sqlalchemy.String(16), default="password"),
    sqlalchemy.Column("password", sqlalchemy.String(256), default=""),
    sqlalchemy.Column("private_key", sqlalchemy.Text, default=""),
    sqlalchemy.Column("key_file", sqlalchemy.String(512), default=""),
    sqlalchemy.Column("country", sqlalchemy.String(64), default=""),
    sqlalchemy.Column("provider", sqlalchemy.String(64), default=""),
    sqlalchemy.Column("business", sqlalchemy.String(128), default=""),
)

engine = sqlalchemy.create_engine("sqlite:///data/nodes.db")
metadata.create_all(engine)
