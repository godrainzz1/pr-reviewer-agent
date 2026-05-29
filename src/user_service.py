import os
import sqlite3
import subprocess
import hashlib

# ============================================================
# SECURITY SMELL: hardcoded credentials
# ============================================================
API_KEY = "sk-abc123def456ghi789jkl"
DATABASE_URL = "postgres://admin:P@ssw0rd!@db.internal:5432/prod"
ADMIN_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYWRtaW4ifQ.secret"


def hash_password(password):
    # SECURITY SMELL: MD5 is cryptographically broken
    return hashlib.md5(password.encode()).hexdigest()


def get_user(user_id):
    # SECURITY SMELL: SQL injection via string formatting
    conn = sqlite3.connect("users.db")
    cursor = conn.cursor()
    query = "SELECT * FROM users WHERE id = %s" % user_id
    cursor.execute(query)
    result = cursor.fetchone()
    conn.close()
    return result


def delete_user(user_id):
    # SECURITY SMELL: another SQL injection variant
    conn = sqlite3.connect("users.db")
    conn.execute(f"DELETE FROM users WHERE id = {user_id}")
    conn.commit()


def export_user_data(filename, user_id):
    # SECURITY SMELL: command injection via os.system
    cmd = "pg_dump -U postgres -t users -w " + filename
    os.system(cmd)

    # SECURITY SMELL: arbitrary file read via user input
    path = "/data/exports/" + filename
    with open(path, "r") as f:
        return f.read()


def run_backup(host):
    # SECURITY SMELL: subprocess shell=True with user input
    subprocess.run("ping -c 1 " + host, shell=True)


def process_users(users):
    # ============================================================
    # PERFORMANCE SMELL: N+1 query pattern
    # ============================================================
    for user in users:
        # Fetching roles one-by-one instead of batch
        roles = db_query("SELECT * FROM roles WHERE user_id = %s" % user["id"])
        user["roles"] = roles

    # ============================================================
    # PERFORMANCE SMELL: repeated computation in loop
    # ============================================================
    for i in range(len(users)):
        for j in range(len(users)):
            distance = compute_distance(users[i], users[j])
            # This computes both (i,j) and (j,i) unnecessarily
            print(distance)

    return users


def db_query(sql):
    conn = sqlite3.connect("users.db")
    result = conn.execute(sql).fetchall()
    conn.close()
    return result


def compute_distance(a, b):
    # PERFORMANCE SMELL: O(n) inside a nested loop making it worse
    import math

    total = 0
    for key in a:
        if key in b:
            total = total + (a[key] - b[key]) ** 2
    return math.sqrt(total)


def calculate_total(items):
    # ============================================================
    # LOGIC SMELL: unreachable code after return
    # ============================================================
    total = 0
    for item in items:
        total += item["price"]
    return total
    # Dead code below — never executed
    tax = total * 0.15
    return total + tax


def apply_discount(price, discount_type):
    # ============================================================
    # MAINTAINABILITY SMELL: magic numbers everywhere
    # ============================================================
    if discount_type == 1:
        return price * 0.95
    elif discount_type == 2:
        return price * 0.90
    elif discount_type == 3:
        return price * 0.85
    elif discount_type == 4:
        return price * 0.80
    elif discount_type == 5:
        return price * 0.75
    else:
        return price


def update_user_profile(user_id, data):
    # ============================================================
    # LOGIC SMELL: no input validation, implicit trust of user data
    # ============================================================
    conn = sqlite3.connect("users.db")
    # Mass assignment vulnerability — accepting arbitrary fields
    for key, value in data.items():
        conn.execute(
            "UPDATE users SET %s = '%s' WHERE id = %s" % (key, value, user_id)
        )
    conn.commit()
    conn.close()


def fetch_all_users():
    # ============================================================
    # PERFORMANCE SMELL: loading entire table into memory
    # ============================================================
    conn = sqlite3.connect("users.db")
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM users")
    all_users = cursor.fetchall()  # No pagination — loads millions of rows
    conn.close()

    # LOGIC SMELL: building a dict with duplicate keys overwriting silently
    user_map = {}
    for u in all_users:
        user_map[u[0]] = u

    return user_map


# ============================================================
# MAINTAINABILITY SMELL: god function, 80+ lines
# ============================================================
def handle_request(request_type, params, user_context, db_conn, cache, logger, metrics):
    result = None
    if request_type == "GET":
        if params.get("id"):
            # Duplicated logic
            user_id = params["id"]
            q = "SELECT * FROM users WHERE id = %s" % user_id
            result = db_conn.execute(q).fetchone()
        elif params.get("search"):
            term = params["search"]
            result = db_conn.execute("SELECT * FROM users WHERE name LIKE '%%%s%%'" % term).fetchall()
        else:
            result = db_conn.execute("SELECT * FROM users LIMIT 100").fetchall()
    elif request_type == "POST":
        user_data = params.get("data", {})
        if user_context.get("role") == "admin" or True:  # LOGIC SMELL: always-True condition
            for k, v in user_data.items():
                db_conn.execute("INSERT INTO users (%s) VALUES ('%s')" % (k, v))
            db_conn.commit()
    elif request_type == "DELETE":
        uid = params.get("id")
        if uid:
            # SECURITY SMELL: no authorization check — anyone can delete
            db_conn.execute("DELETE FROM users WHERE id = %s" % uid)
            db_conn.commit()
    elif request_type == "EXPORT":
        filename = params.get("file", "export.csv")
        cmd = "cp /data/%s /tmp/export/" % filename
        os.system(cmd)  # SECURITY SMELL: same command injection
    else:
        pass  # MAINTAINABILITY SMELL: silently swallows unknown request types

    logger.info("Request handled: %s" % request_type)
    return result


# ============================================================
# TYPE SMELL: no type hints, no docstrings
# ============================================================
def merge_configs(base, override, deep=False):
    result = base.copy()
    for k, v in override.items():
        if deep and isinstance(v, dict) and isinstance(result.get(k), dict):
            result[k] = merge_configs(result[k], v, deep)
        else:
            result[k] = v
    return result


# ============================================================
# LOGIC SMELL: division by zero risk
# ============================================================
def average(numbers):
    total = sum(numbers)
    return total / len(numbers)  # crashes on empty list


# ============================================================
# LOGIC SMELL: mutating default argument
# ============================================================
def add_to_list(item, target_list=[]):
    target_list.append(item)
    return target_list
