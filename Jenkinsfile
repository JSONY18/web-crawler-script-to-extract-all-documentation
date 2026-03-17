pipeline {
    agent any

    // 触发器配置
    triggers {
        GenericTrigger(
            genericVariables: [
                [key: 'ref', value: '$.ref'],
                [key: 'pusher', value: '$.pusher.name']
            ],
            // 这里的 token 需要在 GitHub Webhook URL 中匹配：
            // http://YOUR_JENKINS_IP:8080/generic-webhook-trigger/invoke?token=crawler-secret-123
            token: 'crawler-secret-123',
            
            // 过滤器：只有当推送到 main 分支时才触发构建
            regexpFilterText: '$ref',
            regexpFilterExpression: 'refs/heads/main',
            
            // 构建描述，方便在 Jenkins 界面看到是谁推送的
            causeString: 'Triggered by $pusher on $ref'
        )
    }

    environment {
        PYTHON_APP = "crawler.py"
    }

    stages {
        stage('Checkout') {
            steps {
                echo "--- 正在从 GitHub 拉取最新代码 ---"
                // 建议使用 HTTPS 方式，或者确保 Jenkins 容器内配置了 SSH Key
                git url: 'https://github.com/JSONY18/web-crawler-script-to-extract-all-documentation.git', 
                    branch: 'main'
            }
        }

        stage('Environment Check') {
            steps {
                echo "--- 检查运行环境 ---"
                sh 'python3 --version'
                sh 'pip --version'
                // 如果你有 requirements.txt，可以在这里安装依赖
                // sh 'pip install -r requirements.txt'
            }
        }

        stage('Run Crawler') {
            steps {
                echo "--- 开始运行爬虫脚本 ---"
                // 运行你的 Python 脚本
                sh "python3 ${env.PYTHON_APP}"
            }
        }

        stage('Archive Results') {
            steps {
                echo "--- 归档抓取到的文档数据 ---"
                // 假设你的爬虫生成了 .json 或 .csv 文件
                archiveArtifacts artifacts: '*.json, *.csv', allowEmptyArchive: true
            }
        }
    }

    post {
        success {
            echo '构建成功！爬虫任务已完成。'
        }
        failure {
            echo '构建失败，请检查控制台日志。'
        }
    }
}
