# pretty-print JSON from stdin
pp() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.stringify(JSON.parse(s),null,2))}catch(e){console.log(s)}})'; }
