const fs = require('fs');
const path = require('path');

function walkDir(dir, callback) {
    fs.readdirSync(dir).forEach(f => {
        let dirPath = path.join(dir, f);
        let isDirectory = fs.statSync(dirPath).isDirectory();
        isDirectory ? walkDir(dirPath, callback) : callback(path.join(dir, f));
    });
}

const routes = [];

walkDir(path.join(__dirname, '../src/modules'), function(filePath) {
    if (!filePath.endsWith('.controller.ts')) return;
    
    const content = fs.readFileSync(filePath, 'utf8');
    let baseRoute = '';
    const controllerMatch = content.match(/@Controller\((['"`])(.*?)\1\)/);
    if (controllerMatch) {
        baseRoute = controllerMatch[2];
    } else if (content.includes('@Controller()')) {
        baseRoute = '';
    }
    
    const methodRegex = /@(Get|Post|Put|Delete|Patch)\((?:(['"`])(.*?)\2)?\)/g;
    let methodMatch;
    while ((methodMatch = methodRegex.exec(content)) !== null) {
        const method = methodMatch[1].toUpperCase();
        let subRoute = methodMatch[3] || '';
        if (subRoute && !subRoute.startsWith('/')) {
            subRoute = '/' + subRoute;
        }
        let fullRoute = `/${baseRoute}${subRoute}`.replace(/\/+/g, '/').replace(/\/$/, '');
        if (fullRoute === '') fullRoute = '/';
        routes.push(`${method.padEnd(6)} ${fullRoute}`);
    }
});

fs.writeFileSync(path.join(__dirname, 'routes.txt'), routes.join('\n'));
console.log(`Extracted ${routes.length} routes.`);
